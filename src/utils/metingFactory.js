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

export const createMeting = (server, cookie) => {
  const meting = new Meting(server)
  patchNeteaseEapiEncrypt(meting)
  meting.format(true)
  if (cookie) meting.cookie(cookie)
  if (server === 'tencent') patchTencentSearch(meting)
  return meting
}
