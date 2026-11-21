import hashjs from 'hash.js'
import { HTTPException } from 'hono/http-exception'
import { loadConfig } from '../config.js'
import { format as lyricFormat } from '../utils/lyric.js'
import { resolveCookie, isAllowedHost } from '../utils/cookie.js'
import { recoverCookie } from '../utils/cookieGuard.js'
import { findUrlFallback } from '../utils/fallback.js'
import { createMeting } from '../utils/metingFactory.js'
import { LRUCache } from 'lru-cache'

const cache = new LRUCache({
  max: 1000,
  ttl: 1000 * 30
})

const METING_METHODS = {
  search: 'search',
  song: 'song',
  album: 'album',
  artist: 'artist',
  playlist: 'playlist',
  lrc: 'lyric',
  url: 'url',
  pic: 'pic'
}

const invoke = async (meting, method, id) => {
  let response
  try {
    response = await meting[method](id)
  } catch (error) {
    console.error('[api] 上游调用失败:', error)
    throw new HTTPException(500, { message: '上游 API 调用失败' })
  }
  try {
    return JSON.parse(response)
  } catch (error) {
    throw new HTTPException(500, { message: '上游 API 返回格式异常' })
  }
}

export default async (c) => {
  const config = loadConfig(c.env, c.req.url)
  const baseUrl = config.meting.url || new URL(c.req.url).origin
  const token = config.meting.token || 'token'

  // 1. 初始化参数
  const query = c.req.query()
  const server = query.server || 'netease'
  const type = query.type || 'search'
  const id = query.id || 'hello'
  const authToken = query.token || query.auth || token

  // 2. 校验参数
  if (!['netease', 'tencent', 'kugou', 'baidu', 'kuwo'].includes(server)) {
    throw new HTTPException(400, { message: 'server 参数不合法' })
  }
  if (!['song', 'album', 'search', 'artist', 'playlist', 'lrc', 'url', 'pic'].includes(type)) {
    throw new HTTPException(400, { message: 'type 参数不合法' })
  }

  // 3. 鉴权
  if (['lrc', 'url', 'pic'].includes(type)) {
    if (auth(server, type, id, token) !== authToken) {
      throw new HTTPException(401, { message: '鉴权失败,非法调用' })
    }
  }

  // 4. 解析本次请求的 Cookie（含失效降级状态）
  const referrer = c.req.header('referer')
  const cookieAllowed = isAllowedHost(referrer, config.meting.cookie.allowHosts)
  const resolved = await resolveCookie(server, c.env, { allowed: cookieAllowed })

  let cookieState = resolved.state
  let cookieSource = resolved.source

  // 5. 调用 API
  // 缓存按「是否带 Cookie」分桶，避免匿名请求复用 VIP 直链
  const cookieMode = resolved.cookie ? 'ck' : 'anon'
  const cacheKey = `${server}/${type}/${id}/${cookieMode}`
  let data = cache.get(cacheKey)
  let fallbackInfo = null

  if (data === undefined) {
    c.header('x-cache', 'miss')
    if (type === 'url') {
      // 直链接口是风控重灾区（网易云 code -462、腾讯频控 2001），上游往往直接
      // 抛错而不是返回空 url。若让异常冒泡，接口就是 500，跨平台兜底根本没机会
      // 接手 —— 播放器彻底没声音。这里把异常转成「空直链」，让兜底逻辑继续走。
      try {
        data = await invoke(createMeting(server, resolved.cookie), 'url', id)
      } catch (error) {
        console.warn('[api] 直链上游异常，转入兜底:', error?.message)
        data = { url: '' }
      }
    } else {
      data = await invoke(createMeting(server, resolved.cookie), METING_METHODS[type], id)
    }

    // 5.1 腾讯直链为空：可能是 Cookie 失效，立即体检并按需切换备用/匿名
    if (type === 'url' && !data?.url && server === 'tencent' && cookieAllowed) {
      const recovery = await recoverCookie(c.env, { reason: 'url_empty' })
      if (recovery?.status) {
        cookieState = recovery.status
        if (recovery.status === 'degraded') cookieSource = 'backup'
        if (recovery.status === 'anonymous') cookieSource = 'anonymous'
      }
      if (recovery?.cookie && recovery.cookie !== resolved.cookie) {
        try {
          const retried = await invoke(createMeting(server, recovery.cookie), 'url', id)
          if (retried?.url) {
            data = retried
            cookieSource = recovery.status === 'anonymous' ? 'anonymous' : 'backup'
          }
        } catch (error) {
          // 换 Cookie 重试失败不阻断后续跨平台兜底
          console.warn('[api] 切换 Cookie 重试失败:', error?.message)
        }
      }
    }

    // 5.2 仍然拿不到直链：临时跨平台兜底，保证音乐能继续播
    // 不限平台：网易云的 player/url 会被风控（code -462）导致直链稳定拿不到，
    // 原来只在 tencent 上兜底，等于网易云一被拦就彻底哑火。
    if (type === 'url' && !data?.url) {
      const fallback = await findUrlFallback(server, id, c.env)
      if (fallback) {
        data = { url: fallback.url, size: 0, br: -1 }
        fallbackInfo = fallback
        c.header('x-fallback-source', fallback.sameServer ? `${fallback.target}-same` : fallback.target)
        c.header('x-fallback-match', fallback.match)
        console.warn('[api] 使用兜底:', JSON.stringify({ target: fallback.target, sameServer: Boolean(fallback.sameServer), matched: fallback.matched }))
      }
    }

    if (type === 'url') {
      const ttl = data?.url ? (fallbackInfo ? 1000 * 60 : 1000 * 60 * 10) : 1000 * 60
      cache.set(cacheKey, data, { ttl })
    } else {
      cache.set(cacheKey, data, { ttl: 1000 * 60 * 60 })
    }
  }

  c.header('x-cookie-state', cookieState)
  c.header('x-cookie-source', cookieSource)

  // 6. 组装结果
  if (type === 'url') {
    let url = data?.url
    if (!url) {
      return c.body(null, 404)
    }
    if (server === 'netease') {
      url = url
        .replace('://m7c.', '://m7.')
        .replace('://m8c.', '://m8.')
        .replace('http://', 'https://')
      if (url.includes('vuutv=')) {
        const tempUrl = new URL(url)
        tempUrl.search = ''
        url = tempUrl.toString()
      }
    }
    if (server === 'tencent') {
      url = url
        .replace('http://', 'https://')
        .replace('://ws.stream.qqmusic.qq.com', '://dl.stream.qqmusic.qq.com')
    }
    if (server === 'baidu') {
      url = url
        .replace('http://zhangmenshiting.qianqian.com', 'https://gss3.baidu.com/y0s1hSulBw92lNKgpU_Z2jR7b2w6buu')
    }
    return c.redirect(url)
  }

  if (type === 'pic') {
    const url = data?.url
    if (!url) {
      return c.body(null, 404)
    }
    return c.redirect(url)
  }

  if (type === 'lrc') {
    return c.text(lyricFormat(data.lyric, data.tlyric || ''))
  }

  return c.json(
    data.map((x) => {
      return {
        title: x.name,
        author: x.artist.join(' / '),
        url: `${baseUrl}/api?server=${server}&type=url&id=${x.url_id}&auth=${auth(server, 'url', x.url_id, token)}`,
        pic: `${baseUrl}/api?server=${server}&type=pic&id=${x.pic_id}&auth=${auth(server, 'pic', x.pic_id, token)}`,
        lrc: `${baseUrl}/api?server=${server}&type=lrc&id=${x.lyric_id}&auth=${auth(server, 'lrc', x.lyric_id, token)}`
      }
    })
  )
}

const auth = (server, type, id, token) => {
  return hashjs.hmac(hashjs.sha1, token).update(`${server}${type}${id}`).digest('hex')
}
