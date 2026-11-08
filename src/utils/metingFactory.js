import Meting from '@meting/core'
import aesjs from 'aes-js'
import { createHash } from 'crypto'

/**
 * Cloudflare Workers 禁用 AES-ECB，@meting/core 在网易云请求中用到了 aes-128-ecb。
 * 这里用纯 JS 实现的 AES-ECB 替换默认实现，避免 createCipheriv 报 iv 为 null。
 */
export const patchNeteaseEapiEncrypt = (meting) => {
  const provider = meting?.provider
  if (!provider || provider.name !== 'netease') return

  const proto = Object.getPrototypeOf(provider)
  if (proto.__patchedEapi) return
  proto.__patchedEapi = true

  proto.eapiEncrypt = (req) => {
    const bodyStr = JSON.stringify(req.body)
    const path = req.url.replace(/https?:\/\/[^/]+/, '')
    const signSeed = `nobody${path}use${bodyStr}md5forencrypt`
    const sign = createHash('md5').update(signSeed).digest('hex')
    const payload = `${path}-36cd479b6b5-${bodyStr}-36cd479b6b5-${sign}`

    const key = Buffer.from('e82ckenh8dichen8', 'utf8')
    const textBytes = Buffer.from(payload, 'utf8')
    const padded = aesjs.padding.pkcs7.pad(textBytes)
    const aesEcb = new aesjs.ModeOfOperation.ecb(key)
    const encryptedBytes = aesEcb.encrypt(padded)
    const encryptedHex = Buffer.from(encryptedBytes).toString('hex').toUpperCase()

    req.url = req.url.replace('/api/', '/eapi/')
    req.body = { params: encryptedHex }
    return req
  }
}

/**
 * QQ 音乐旧搜索接口 c.y.qq.com/soso/fcgi-bin/client_search_cp 已下线（全域名 HTTP 500），
 * 这里改用 u.y.qq.com/cgi-bin/musicu.fcg 的 SearchCgiService。
 *
 * 实测要点：
 * - 必须用 GET（POST 更容易被判定为异常客户端，直接返回 2001）
 * - 需要完整浏览器 UA + Referer + Origin，缺一个就可能被拦
 * - 频控码是 req_0.code === 2001，连续请求 3~4 次就会触发，所以要做退避重试
 */
const TENCENT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const randomPvid = () => String(Math.floor(Math.random() * 9e9) + 1e9)

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const tencentSearch = async (keyword, { limit = 30, page = 1 } = {}) => {
  const payload = {
    req_0: {
      module: 'music.search.SearchCgiService',
      method: 'DoSearchForQQMusicDesktop',
      param: { query: keyword, num_per_page: limit, page_num: page }
    }
  }

  // 注意：不能用 URLSearchParams，它把空格编码成 "+"，
  // 而 QQ 侧不会把 data 里的 "+" 还原成空格，query 变成 "晴天+周杰伦" 就搜不到并返回 2001。
  const query = [
    'format=json',
    'platform=yqq.json',
    'needNewCode=0',
    `data=${encodeURIComponent(JSON.stringify(payload))}`
  ].join('&')

  const request = (pvid) => fetch(`https://u.y.qq.com/cgi-bin/musicu.fcg?${query}`, {
    method: 'GET',
    headers: {
      'User-Agent': TENCENT_UA,
      Referer: 'https://y.qq.com/',
      Origin: 'https://y.qq.com',
      Cookie: `pgv_pvid=${pvid}; qqmusic_fromtag=66; yplayer_open=1`
    }
  })

  let body = null
  let lastCode = null
  const pvid = randomPvid()

  // 2001 是频控码：退避后重试一次即可，短间隔连打只会让风控窗口更长
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await request(attempt === 0 ? pvid : randomPvid())
      body = await response.json()
      lastCode = body?.req_0?.code
      if (lastCode === 0) break
      if (lastCode !== 2001) break
    } catch (error) {
      lastCode = error?.message || 'network'
    }
    if (attempt === 0) await sleep(900)
  }

  if (lastCode !== 0) {
    const error = new Error(`腾讯搜索失败（code=${lastCode}）`)
    error.code = lastCode
    throw error
  }

  const list = body?.req_0?.data?.body?.song?.list || []
  return JSON.stringify(list.map((song) => ({
    id: song.mid,
    name: song.name,
    artist: (song.singer || []).map(item => item.name),
    album: song.album?.name || song.album?.title || '',
    pic_id: song.album?.mid || '',
    url_id: song.mid,
    lyric_id: song.mid,
    source: 'tencent'
  })))
}

/**
 * 腾讯 provider 的 search 走旧接口（已 500），在实例上覆盖为新的搜索实现。
 * 只覆盖实例方法，不影响 @meting/core 的 url()/lyric() 等逻辑。
 */
const patchTencentSearch = (meting) => {
  meting.search = (keyword, options = {}) => tencentSearch(keyword, {
    limit: options.limit ?? 30,
    page: options.page ?? 1
  })
}

/**
 * @meting/core 的腾讯 url() 依赖旧接口 c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg，
 * 而同一个 c.y.qq.com 域下的搜索接口已经整片 500 下线。这里改用官方客户端接口：
 *   music.pf_song_detail_svr  取 media_mid / 各码率文件大小
 *   vkey.GetVkeyServer        一次请求全部码率，从高到低取第一个有 purl 的
 *
 * 相对原实现的三点改进：
 * 1. 不再依赖 c.y.qq.com（旧域名接口随时可能下线）
 * 2. 请求带 comm.authst / loginUin，带 Cookie 时服务端才能识别 VIP 身份
 * 3. 直链强制 https——上游 sip 只给 http，https 站点播放会被浏览器按混合内容拦截
 */
const TENCENT_QUALITY = [
  ['size_flac', 999, 'F000', '.flac'],
  ['size_320mp3', 320, 'M800', '.mp3'],
  ['size_192aac', 192, 'C600', '.m4a'],
  ['size_128mp3', 128, 'M500', '.mp3'],
  ['size_96aac', 96, 'C400', '.m4a'],
  ['size_48aac', 48, 'C200', '.m4a']
]

// media_mid 不会变，缓存详情省一次往返（旧实现每首都要查一次详情）
const detailCache = new Map()
const DETAIL_TTL = 60 * 60 * 1000
const DETAIL_CACHE_MAX = 500

const parseTencentCookie = (cookie = '') => {
  const text = String(cookie || '')
  const uin = text.match(/(?:^|;\s*)uin=o?(\d+)/)
  const key = text.match(/(?:^|;\s*)(?:qqmusic_key|qm_keyst)=([^;]+)/)
  return {
    uin: uin ? uin[1] : '0',
    authst: key ? key[1].trim() : ''
  }
}

const tencentPost = async (payload) => {
  const response = await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'POST',
    headers: {
      'User-Agent': TENCENT_UA,
      Referer: 'https://y.qq.com/',
      Origin: 'https://y.qq.com',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  })
  return response.json()
}

const getTencentDetail = async (songmid) => {
  const cached = detailCache.get(songmid)
  if (cached && Date.now() - cached.at < DETAIL_TTL) return cached.detail

  const body = await tencentPost({
    req_0: {
      module: 'music.pf_song_detail_svr',
      method: 'get_song_detail_yqq',
      param: { song_mid: songmid }
    },
    comm: { format: 'json', ct: 19, cv: 0 }
  })

  const track = body?.req_0?.data?.track_info
  if (!track) return null

  const detail = { file: track.file || {}, type: track.type ?? 0 }
  if (detailCache.size >= DETAIL_CACHE_MAX) detailCache.clear()
  detailCache.set(songmid, { detail, at: Date.now() })
  return detail
}

// sip 只给 http；ws.stream.qqmusic.qq.com 实测支持 https，避免混合内容拦截
const pickSip = (sip = []) => {
  for (const item of sip) {
    if (typeof item === 'string' && item.startsWith('https://')) return item
  }
  return 'https://ws.stream.qqmusic.qq.com/'
}

const tencentUrl = async (songmid, { maxBr = 999, cookie = '' } = {}) => {
  const detail = await getTencentDetail(songmid)
  if (!detail) return JSON.stringify({ url: '', size: 0, br: -1 })

  // 播放地址必须用 media_mid 构造 filename，它和 songmid 常常不同
  const mediaMid = detail.file.media_mid || songmid
  const tiers = TENCENT_QUALITY.filter(([key, br]) => detail.file[key] && br <= maxBr)
  if (tiers.length === 0) return JSON.stringify({ url: '', size: 0, br: -1 })

  const filenames = tiers.map(([, , prefix, ext]) => `${prefix}${mediaMid}${ext}`)
  const { uin, authst } = parseTencentCookie(cookie)
  const guid = String(Math.floor(Math.random() * 9e9) + 1e9)

  const body = await tencentPost({
    req_0: {
      module: 'vkey.GetVkeyServer',
      method: 'CgiGetVkey',
      param: {
        filename: filenames,
        guid,
        songmid: tiers.map(() => songmid),
        songtype: tiers.map(() => detail.type),
        uin,
        loginflag: 1,
        platform: '20'
      }
    },
    loginUin: uin,
    comm: { uin, format: 'json', ct: 19, cv: 0, authst }
  })

  const data = body?.req_0?.data
  const list = data?.midurlinfo || []
  const sip = data?.sip || []

  // 按 filename 映射，避免上游返回顺序与请求顺序不一致时选错音质
  const byName = new Map()
  for (const item of list) {
    if (item?.filename) byName.set(item.filename, item)
  }

  const base = pickSip(sip)
  for (let i = 0; i < filenames.length; i++) {
    const purl = String(byName.get(filenames[i])?.purl || '').trim()
    if (!purl) continue
    const url = purl.startsWith('http') ? purl : base + purl
    const [sizeKey, br] = tiers[i]
    return JSON.stringify({ url, size: detail.file[sizeKey] || 0, br })
  }

  return JSON.stringify({ url: '', size: 0, br: -1 })
}

/**
 * 用新接口覆盖 url()；新接口异常时回退 @meting/core 原实现，
 * 保证上游参数变化时不会整条链路不可用。
 */
const patchTencentUrl = (meting, cookie) => {
  const fallback = meting.url.bind(meting)

  // 默认 320，与 @meting/core 的 url(id, br=320) 保持一致；要 FLAC 显式传 999
  meting.url = async (id, br = 320) => {
    try {
      const raw = await tencentUrl(String(id), { maxBr: br, cookie })
      if (JSON.parse(raw)?.url) return raw
    } catch (error) {
      console.warn('[meting] 腾讯新 url 接口失败，回退原实现:', error?.message)
    }

    const legacy = await fallback(id, br)
    // 原实现拼的是 http 直链，能拿到就顺手升级成 https
    try {
      const data = JSON.parse(legacy)
      if (data?.url?.startsWith('http://')) {
        data.url = data.url.replace(/^http:\/\//, 'https://')
        return JSON.stringify(data)
      }
    } catch (error) {
      // 保持原样
    }
    return legacy
  }
}

export const createMeting = (server, cookie) => {
  const meting = new Meting(server)
  patchNeteaseEapiEncrypt(meting)
  meting.format(true)
  if (cookie) meting.cookie(cookie)
  if (server === 'tencent') {
    patchTencentSearch(meting)
    patchTencentUrl(meting, cookie)
  }
  return meting
}
