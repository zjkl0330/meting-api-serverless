import { createHash } from 'node:crypto'
import { parseCookie } from './cookieFormat.js'
import { getPrimaryCookie, savePrimaryCookie } from './cookieStore.js'

const REFRESH_TIMEOUT_MS = 8000

const fail = (message, extra = {}) => ({
  success: false,
  ok: false,
  invalid: false,
  code: null,
  message,
  ...extra
})

/**
 * 用指定 Cookie 调用 QQ 音乐 LoginServer 续期。
 *
 * 返回结构：
 * - ok: true              续期成功
 * - invalid: true         Cookie 确定失效（上游明确返回错误码/缺关键字段）
 * - 两者都 false           网络/上游异常，状态未知，不能据此判定失效
 */
export async function refreshTencentCookie (env, cookie) {
  const currentCookie = String(cookie || '').trim()
  if (!currentCookie) {
    return fail('未找到 QQ 音乐 Cookie', { invalid: true, code: 'no_cookie' })
  }

  const cookieDict = parseCookie(currentCookie)
  const refreshToken = cookieDict.psrf_qqrefresh_token
  const openid = cookieDict.psrf_qqopenid
  const uin = cookieDict.uin || ''
  const strMusicId = uin.replace(/\D/g, '')
  const musicKey = cookieDict.qqmusic_key || cookieDict.qm_keyst || ''
  const accessToken = cookieDict.psrf_qqaccess_token || ''
  const refreshKey = cookieDict.psrf_qqrefresh_key || ''

  const qimei36 = cookieDict._qimei_q36 || ''
  const qimei16 = cookieDict._qimei_q16 || (qimei36 ? qimei36.substring(0, 16) : '')

  if (!refreshToken || !openid) {
    return fail('Cookie 缺少关键字段 (psrf_qqrefresh_token/psrf_qqopenid)，无法自动续期', {
      invalid: true,
      code: 'missing_fields'
    })
  }

  const comm = buildComm(strMusicId, musicKey, qimei16, qimei36)
  const reqData = {
    comm,
    req: {
      module: 'music.login.LoginServer',
      method: 'Login',
      param: {
        openid,
        access_token: accessToken,
        refresh_token: refreshToken,
        expired_in: 0,
        musicid: parseInt(strMusicId || '0'),
        musickey: musicKey,
        refresh_key: refreshKey,
        loginMode: 2
      }
    }
  }

  const bodyStr = JSON.stringify(reqData)
  const sign = signBody(bodyStr)

  let response
  try {
    response = await fetch(`https://u.y.qq.com/cgi-bin/musics.fcg?sign=${sign}`, {
      method: 'POST',
      headers: {
        'User-Agent': 'Android12-AndroidPhone-20349-201-0-ting#958959317/661004247-LOGIN-wifi',
        'Content-Type': 'application/json'
      },
      body: bodyStr,
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout
        ? AbortSignal.timeout(REFRESH_TIMEOUT_MS)
        : undefined
    })
  } catch (error) {
    // 网络异常不代表 Cookie 失效
    console.warn('[refresher] 续期请求异常:', error?.message)
    return fail(`续期请求异常: ${error?.message}`)
  }

  if (!response.ok) {
    return fail(`续期接口返回 HTTP ${response.status}`)
  }

  let data
  try {
    data = await response.json()
  } catch (error) {
    return fail('续期接口返回非 JSON 数据')
  }

  const code = data?.req?.code
  if (code !== 0) {
    return {
      success: false,
      ok: false,
      invalid: true,
      code: code ?? 'unknown',
      message: `刷新失败 (Code: ${code ?? 'Unknown'})，Cookie 可能已失效`,
      detail: JSON.stringify(data).slice(0, 500)
    }
  }

  const loginData = data.req.data || {}
  const newCookies = {}

  if (loginData.musickey) {
    newCookies.qm_keyst = loginData.musickey
    newCookies.qqmusic_key = loginData.musickey
  }
  if (loginData.qqmusic_key) newCookies.qqmusic_key = loginData.qqmusic_key
  if (loginData.refresh_token) newCookies.psrf_qqrefresh_token = loginData.refresh_token
  if (loginData.access_token) newCookies.psrf_qqaccess_token = loginData.access_token
  if (loginData.openid) newCookies.psrf_qqopenid = loginData.openid
  if (loginData.refresh_key) newCookies.psrf_qqrefresh_key = loginData.refresh_key

  const updatedCookieDict = { ...cookieDict, ...newCookies }
  const updatedCookieStr = Object.entries(updatedCookieDict)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')

  return {
    success: true,
    ok: true,
    invalid: false,
    code: 0,
    changed: updatedCookieStr !== currentCookie,
    cookie: updatedCookieStr,
    message: updatedCookieStr !== currentCookie ? 'QQ 音乐 Cookie 刷新成功' : 'Cookie 未发生变化'
  }
}

/**
 * 从存储里取出主 Cookie 并续期，成功时写回 primary（是否切为生效 Cookie 交给 guard 决定）
 */
export async function refreshQQCookie (env) {
  const cookie = await getPrimaryCookie(env)
  if (!cookie) {
    return fail('未找到 QQ 音乐 Cookie', { invalid: true, code: 'no_cookie' })
  }

  const result = await refreshTencentCookie(env, cookie)
  if (result.ok) {
    await savePrimaryCookie(env, result.cookie, { activate: false })
  }
  return result
}

function signBody (payload) {
  const PART_1_INDEXES = [23, 14, 6, 36, 16, 40, 7, 19].filter(x => x < 40)
  const PART_2_INDEXES = [16, 1, 32, 12, 19, 27, 8, 5]
  const SCRAMBLE_VALUES = [89, 39, 179, 150, 218, 82, 58, 252, 177, 52, 186, 123, 120, 64, 242, 133, 143, 161, 121, 179]

  const hash = createHash('sha1').update(payload, 'utf8').digest('hex').toUpperCase()

  const part1 = PART_1_INDEXES.map(i => hash[i]).join('')
  const part2 = PART_2_INDEXES.map(i => hash[i]).join('')

  const part3 = new Uint8Array(20)
  for (let i = 0; i < SCRAMBLE_VALUES.length; i++) {
    const v = SCRAMBLE_VALUES[i]
    const hexVal = parseInt(hash.substring(i * 2, i * 2 + 2), 16)
    part3[i] = v ^ hexVal
  }

  let binary = ''
  for (let i = 0; i < part3.length; i++) {
    binary += String.fromCharCode(part3[i])
  }
  const b64Part = btoa(binary).replace(/[\\/+=]/g, '')

  return `zzc${part1}${b64Part}${part2}`.toLowerCase()
}

function buildComm (uin, token, qimei16, qimei36) {
  const randomHex = (len) => {
    let res = ''
    const chars = '0123456789abcdef'
    for (let i = 0; i < len; i++) res += chars[Math.floor(Math.random() * chars.length)]
    return res
  }

  const QIMEI = qimei16 || randomHex(16)
  const QIMEI36 = qimei36 || randomHex(36)

  const common = {
    v: 14090008,
    ct: 11,
    cv: 14090008,
    chid: '2005000982',
    QIMEI,
    QIMEI36,
    tmeAppID: 'qqmusic',
    format: 'json',
    inCharset: 'utf-8',
    outCharset: 'utf-8',
    OpenUDID: 'ffffffffbff94f7d000000000033c587',
    udid: 'ffffffffbff94f7d000000000033c587',
    os_ver: '12',
    aid: 'd2550265db4ce5c4',
    phonetype: '22011211C',
    devicelevel: 31,
    newdevicelevel: 31,
    nettype: '1030',
    rom: '12',
    OpenUDID2: 'ffffffffbff94f7d000001999ff7d5bf'
  }

  if (uin && token) {
    common.qq = uin
    common.authst = token
    common.tmeLoginType = 2
  }

  return common
}
