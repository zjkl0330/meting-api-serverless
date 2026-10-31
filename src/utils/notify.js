import { getJson, putJson, kvGet, kvPut, kvDelete } from './store.js'

const WEBHOOK_KEY = 'config_alert_webhook'
const MAX_CONTENT_BYTES = 3800

/**
 * 企业微信机器人 Webhook：优先环境变量，其次 KV（可在后台随时改，不用重新部署）
 */
export async function resolveWebhook (env) {
  const fromEnv = env?.METING_ALERT_WEBHOOK || env?.METING_WECOM_WEBHOOK
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim()
  const stored = await kvGet(env, WEBHOOK_KEY)
  return stored ? String(stored).trim() : ''
}

export async function setWebhook (env, url) {
  const value = String(url || '').trim()
  if (!value) {
    await kvDelete(env, WEBHOOK_KEY)
    return ''
  }
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('Webhook 不是合法 URL')
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Webhook 必须是 http/https 地址')
  }
  await kvPut(env, WEBHOOK_KEY, value)
  return value
}

export function maskWebhook (url) {
  if (!url) return null
  try {
    const parsed = new URL(url)
    const key = parsed.searchParams.get('key') || ''
    return `${parsed.origin}${parsed.pathname}?key=${key ? `${key.slice(0, 6)}***` : ''}`
  } catch {
    return '***'
  }
}

export function formatTime (ts = Date.now()) {
  const d = new Date(ts + 8 * 3600 * 1000)
  return `${d.toISOString().replace('T', ' ').slice(0, 19)} (UTC+8)`
}

function truncateByBytes (text, maxBytes) {
  if (typeof TextEncoder === 'undefined') return text
  const encoder = new TextEncoder()
  if (encoder.encode(text).length <= maxBytes) return text
  let out = text
  while (out.length > 0 && encoder.encode(out).length > maxBytes) {
    out = out.slice(0, -20)
  }
  return `${out}\n…（内容过长已截断）`
}

/**
 * 发送 markdown 消息，任何异常都吞掉，绝不影响播放链路
 */
export async function sendWecom (env, content) {
  const webhook = await resolveWebhook(env)
  if (!webhook) return { sent: false, reason: 'no_webhook' }

  const body = JSON.stringify({
    msgtype: 'markdown',
    markdown: { content: truncateByBytes(content, MAX_CONTENT_BYTES) }
  })

  try {
    const response = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout
        ? AbortSignal.timeout(8000)
        : undefined
    })
    const text = await response.text()
    let payload = null
    try {
      payload = JSON.parse(text)
    } catch {
      payload = text
    }
    const sent = response.ok && payload && typeof payload === 'object' && payload.errcode === 0
    if (!sent) console.warn('[notify] 企业微信发送失败:', response.status, text.slice(0, 200))
    return { sent: Boolean(sent), status: response.status, body: payload }
  } catch (error) {
    console.warn('[notify] 企业微信请求异常:', error?.message)
    return { sent: false, reason: error?.message }
  }
}

/**
 * 带节流的通知：同一 key 在 throttleMs 内只发一次
 */
export async function notifyThrottled (env, { key, content, throttleMs = 0 }) {
  const stateKey = `alert_${key}`
  const last = await getJson(env, stateKey, null)
  const now = Date.now()

  if (last && typeof last.at === 'number' && now - last.at < throttleMs) {
    return { sent: false, throttled: true, lastAt: last.at }
  }

  const result = await sendWecom(env, content)
  if (result.sent) {
    await putJson(env, stateKey, { at: now })
  }
  return result
}

export async function lastAlertAt (env, key) {
  const last = await getJson(env, `alert_${key}`, null)
  return last?.at || 0
}
