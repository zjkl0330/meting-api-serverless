import { getJson, putJson, kvPut, kvDelete, kvGet } from './store.js'
import { cookieFingerprint, maskCookie, parseCookie } from './cookieFormat.js'

export const KEY_ACTIVE = 'cookie_tencent'
export const KEY_PRIMARY = 'cookie_tencent_primary'
export const KEY_BACKUPS = 'cookie_tencent_backups'
export const KEY_STATE = 'cookie_tencent_state'
export const KEY_EVENTS = 'cookie_tencent_events'

export const STATUS = {
  OK: 'ok',
  DEGRADED: 'degraded',
  ANONYMOUS: 'anonymous',
  INVALID: 'invalid',
  UNCONFIGURED: 'unconfigured'
}

const MAX_BACKUPS = 10
const MAX_EVENTS = 20

const defaultState = () => ({
  status: STATUS.UNCONFIGURED,
  activeSource: 'none',
  reason: '',
  since: 0,
  updatedAt: 0,
  failures: 0,
  lastCheck: null,
  lastAlertAt: 0
})

export async function getState (env) {
  const state = await getJson(env, KEY_STATE, null)
  if (!state || typeof state !== 'object') return defaultState()
  return { ...defaultState(), ...state }
}

export async function saveState (env, patch) {
  const state = { ...(await getState(env)), ...patch, updatedAt: Date.now() }
  await putJson(env, KEY_STATE, state)
  return state
}

/**
 * 环境变量里可以直接塞备用 Cookie，用 || 或换行分隔，避免与 Cookie 内部分号冲突
 */
export function parseEnvBackups (env) {
  const raw = env?.METING_COOKIE_TENCENT_BACKUPS || ''
  if (!raw) return []
  return raw
    .split(/\|\||\r?\n/)
    .map(item => item.trim())
    .filter(Boolean)
}

export async function getPrimaryCookie (env) {
  const stored = await kvGet(env, KEY_PRIMARY)
  if (stored) return stored.trim()
  const active = await kvGet(env, KEY_ACTIVE)
  if (active) return active.trim()
  const envCookie = env?.METING_COOKIE_TENCENT || env?.METING_COOKIE || ''
  return String(envCookie).trim()
}

/**
 * 播放时使用的 Cookie。匿名状态下强制返回空串，避免继续用死 Cookie 请求。
 */
export async function getActiveCookie (env) {
  const state = await getState(env)
  if (state.status === STATUS.ANONYMOUS) return ''
  const active = await kvGet(env, KEY_ACTIVE)
  if (active) return active.trim()
  return getPrimaryCookie(env)
}

export async function savePrimaryCookie (env, cookie, { label = '', activate = true } = {}) {
  const value = String(cookie || '').trim()
  await kvPut(env, KEY_PRIMARY, value)
  if (activate) await kvPut(env, KEY_ACTIVE, value)
  if (label) await putJson(env, 'cookie_tencent_primary_label', label)
  return value
}

export async function setActiveCookie (env, cookie) {
  const value = String(cookie || '').trim()
  if (!value) {
    await kvDelete(env, KEY_ACTIVE)
    return ''
  }
  await kvPut(env, KEY_ACTIVE, value)
  return value
}

export async function listBackups (env) {
  const list = await getJson(env, KEY_BACKUPS, [])
  return Array.isArray(list) ? list : []
}

async function saveBackups (env, list) {
  await putJson(env, KEY_BACKUPS, list.slice(0, MAX_BACKUPS))
}

/**
 * 首次使用时把环境变量里的备用 Cookie 导入 KV，后续统一在 KV 里轮换
 */
async function ensureBackups (env) {
  let list = await listBackups(env)
  if (list.length > 0) return list
  const fromEnv = parseEnvBackups(env)
  if (fromEnv.length === 0) return list

  list = fromEnv.map((cookie, index) => ({
    id: `env-${index + 1}`,
    label: `环境变量备用 ${index + 1}`,
    cookie,
    fingerprint: cookieFingerprint(cookie),
    addedAt: Date.now(),
    source: 'env'
  }))
  await saveBackups(env, list)
  return list
}

export async function addBackupCookie (env, cookie, label = '') {
  const value = String(cookie || '').trim()
  if (!value) throw new Error('备用 Cookie 不能为空')

  const list = await ensureBackups(env)
  const fingerprint = cookieFingerprint(value)
  if (list.some(item => item.fingerprint === fingerprint)) {
    return { duplicated: true, backup: list.find(item => item.fingerprint === fingerprint), total: list.length }
  }

  const backup = {
    id: `bk-${Date.now().toString(36)}`,
    label: label || `备用 ${list.length + 1}`,
    cookie: value,
    fingerprint,
    addedAt: Date.now(),
    source: 'admin'
  }
  const next = [...list, backup].slice(0, MAX_BACKUPS)
  await saveBackups(env, next)
  return { duplicated: false, backup, total: next.length }
}

export async function removeBackupCookie (env, id) {
  const list = await ensureBackups(env)
  const next = list.filter(item => item.id !== id)
  if (next.length === list.length) return { removed: false, total: list.length }
  await saveBackups(env, next)
  return { removed: true, total: next.length }
}

export async function rotateToBackup (env) {
  const list = await ensureBackups(env)
  if (list.length === 0) return null

  const [next, ...rest] = list
  await saveBackups(env, rest)
  await setActiveCookie(env, next.cookie)
  await saveState(env, {
    status: STATUS.DEGRADED,
    activeSource: `backup:${next.id}`,
    since: Date.now(),
    reason: '主 Cookie 失效，已切换备用'
  })

  return {
    backup: { id: next.id, label: next.label, fingerprint: next.fingerprint },
    cookie: next.cookie,
    remaining: rest.length
  }
}

export async function degradeToAnonymous (env, reason = '没有可用备用 Cookie') {
  await kvDelete(env, KEY_ACTIVE)
  await saveState(env, {
    status: STATUS.ANONYMOUS,
    activeSource: 'anonymous',
    since: Date.now(),
    reason
  })
}

export async function pushEvent (env, event) {
  const list = await getJson(env, KEY_EVENTS, [])
  const next = [{ at: Date.now(), ...event }, ...(Array.isArray(list) ? list : [])].slice(0, MAX_EVENTS)
  await putJson(env, KEY_EVENTS, next)
  return next
}

export async function listEvents (env) {
  const list = await getJson(env, KEY_EVENTS, [])
  return Array.isArray(list) ? list : []
}

/**
 * 对外展示用的快照，绝不包含完整 Cookie
 */
export async function snapshot (env) {
  const [state, active, primary, backups, events] = await Promise.all([
    getState(env),
    getActiveCookie(env),
    getPrimaryCookie(env),
    listBackups(env),
    listEvents(env)
  ])

  return {
    status: state.status,
    activeSource: state.activeSource,
    reason: state.reason,
    since: state.since,
    updatedAt: state.updatedAt,
    failures: state.failures,
    lastCheck: state.lastCheck,
    primary: primary ? maskCookie(primary) : null,
    active: active ? maskCookie(active) : null,
    backups: backups.map(item => ({
      id: item.id,
      label: item.label,
      addedAt: item.addedAt,
      uin: parseCookie(item.cookie).uin || ''
    })),
    backupCount: backups.length,
    events
  }
}
