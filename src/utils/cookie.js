import { getActiveCookie as getStoredActiveCookie, getState } from './cookieStore.js'
import { parseCookie, inspectTencentCookie, maskCookie, cookieFingerprint } from './cookieFormat.js'

export { parseCookie, inspectTencentCookie, maskCookie, cookieFingerprint }

/**
 * 从环境变量读取指定平台的 cookie。
 * 优先读取 METING_COOKIE_<SERVER>，其次 METING_COOKIE。
 */
export function readCookie (server, env) {
  const envSource = env ?? (typeof process !== 'undefined' ? process.env : {}) ?? {}
  const envKey = `METING_COOKIE_${server.toUpperCase()}`
  const value = envSource[envKey] || envSource.METING_COOKIE || ''
  return value.trim()
}

/**
 * 异步读取 Cookie，优先从 KV 读取 (仅限腾讯)，其次环境变量
 */
export async function readCookieAsync (server, env) {
  if (server === 'tencent') {
    const active = await getStoredActiveCookie(env)
    if (active) return active
  }
  return readCookie(server, env)
}

/**
 * 验证 referrer 是否在允许的主机列表。
 */
export function isAllowedHost (referrer, allowHosts = []) {
  if (!allowHosts || allowHosts.length === 0) return true
  if (!referrer) return false

  try {
    const url = new URL(referrer)
    const hostname = url.hostname.toLowerCase()
    return allowHosts.some(rule => {
      if (rule === hostname) return true
      if (rule.includes('*')) {
        const pattern = rule.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')
        return new RegExp(`^${pattern}$`).test(hostname)
      }
      return false
    })
  } catch (error) {
    return false
  }
}

/**
 * 统一解析本次请求应使用的 Cookie。
 *
 * 返回：
 * - cookie: 实际注入的 Cookie（空字符串表示匿名）
 * - source: primary / backup:xxx / anonymous / env / none / blocked
 * - state: ok / degraded / anonymous / invalid / unconfigured / blocked
 * - blockedByHost: 是否被 referrer 白名单拦截
 */
export async function resolveCookie (server, env, { allowed = true } = {}) {
  if (!allowed) {
    return { cookie: '', source: 'blocked', state: 'blocked', blockedByHost: true }
  }

  if (server !== 'tencent') {
    const cookie = readCookie(server, env)
    return { cookie, source: cookie ? 'env' : 'none', state: cookie ? 'ok' : 'unconfigured', blockedByHost: false }
  }

  const state = await getState(env)
  const cookie = await getStoredActiveCookie(env)

  if (state.status === 'anonymous') {
    return { cookie: '', source: 'anonymous', state: 'anonymous', blockedByHost: false }
  }
  if (!cookie) {
    return { cookie: '', source: 'none', state: 'unconfigured', blockedByHost: false }
  }

  const effectiveState = ['ok', 'degraded', 'invalid', 'unconfigured'].includes(state.status)
    ? state.status
    : 'ok'

  return {
    cookie,
    source: state.activeSource || 'primary',
    state: effectiveState === 'unconfigured' ? 'ok' : effectiveState,
    blockedByHost: false
  }
}
