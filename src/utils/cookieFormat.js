/**
 * Cookie 解析/脱敏/体检（无副作用，供其它模块共用，避免循环依赖）
 */

export function parseCookie (str) {
  const dict = {}
  if (!str) return dict
  str.split(';').forEach(part => {
    const i = part.indexOf('=')
    if (i !== -1) {
      const key = part.substring(0, i).trim()
      const val = part.substring(i + 1).trim()
      if (key) dict[key] = val
    }
  })
  return dict
}

export function inspectTencentCookie (cookie) {
  const dict = parseCookie(cookie)
  const uin = String(dict.uin || dict.p_uin || '').replace(/\D/g, '')
  const musicKey = dict.qqmusic_key || dict.qm_keyst || dict.musickey || ''
  const refreshToken = dict.psrf_qqrefresh_token || ''
  const openid = dict.psrf_qqopenid || ''
  const missing = []

  if (!uin) missing.push('uin')
  if (!musicKey) missing.push('qqmusic_key/qm_keyst')

  const canRefresh = Boolean(refreshToken && openid)

  return {
    ok: missing.length === 0,
    missing,
    uin,
    hasMusicKey: Boolean(musicKey),
    hasRefreshToken: Boolean(refreshToken),
    hasOpenid: Boolean(openid),
    canRefresh,
    warnings: missing.length === 0 && !canRefresh
      ? ['缺少 psrf_qqrefresh_token / psrf_qqopenid，无法自动续期，只能临时使用']
      : []
  }
}

export function maskCookie (cookie) {
  const dict = parseCookie(cookie)
  const uin = String(dict.uin || '').replace(/\D/g, '')
  const key = dict.qqmusic_key || dict.qm_keyst || ''
  const tail = key ? key.slice(-4) : ''
  return `uin=${uin || '?'} key=***${tail}`
}

export function cookieFingerprint (cookie) {
  const dict = parseCookie(cookie)
  const uin = String(dict.uin || '').replace(/\D/g, '')
  const key = dict.qqmusic_key || dict.qm_keyst || ''
  return `${uin}:${key.length}:${key.slice(-6)}`
}
