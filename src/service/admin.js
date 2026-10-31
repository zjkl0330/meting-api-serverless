import { HTTPException } from 'hono/http-exception'
import {
  applyPrimaryCookie,
  maintainCookie,
  forceRotate,
  resetCookieState
} from '../utils/cookieGuard.js'
import {
  addBackupCookie,
  removeBackupCookie,
  listBackups,
  snapshot
} from '../utils/cookieStore.js'
import { setWebhook, resolveWebhook, maskWebhook, sendWecom, formatTime } from '../utils/notify.js'
import { inspectTencentCookie, maskCookie } from '../utils/cookieFormat.js'

const requireAdmin = (c) => {
  const expected = c.env?.METING_ADMIN_TOKEN || c.env?.METING_TOKEN || 'token'
  const provided = c.req.query('token') ||
    (c.req.header('authorization') || '').replace(/^Bearer\s+/i, '')
  if (!provided || provided !== expected) {
    throw new HTTPException(401, { message: '鉴权失败' })
  }
}

const readBody = async (c) => {
  const contentType = c.req.header('content-type') || ''
  if (contentType.includes('application/json')) {
    try {
      return await c.req.json()
    } catch {
      throw new HTTPException(400, { message: '请求体不是合法 JSON' })
    }
  }
  const text = await c.req.text()
  return text ? { cookie: text } : {}
}

export const postCookie = async (c) => {
  requireAdmin(c)
  const body = await readBody(c)
  const cookie = body.cookie || c.req.query('cookie')
  const label = body.label || c.req.query('label') || ''
  const test = body.test === undefined ? c.req.query('test') !== '0' : Boolean(body.test)

  if (!cookie) throw new HTTPException(400, { message: '缺少 cookie 字段' })

  try {
    const result = await applyPrimaryCookie(c.env, cookie, { label, test })
    return c.json({
      ok: true,
      message: '主 Cookie 已更新',
      cookie: maskCookie(cookie),
      inspection: result.inspection,
      verification: result.verification,
      state: result.state
    })
  } catch (error) {
    return c.json({
      ok: false,
      message: error.message,
      details: error.details || null
    }, 400)
  }
}

export const postBackup = async (c) => {
  requireAdmin(c)
  const body = await readBody(c)
  const cookie = body.cookie || c.req.query('cookie')
  const label = body.label || c.req.query('label') || ''
  if (!cookie) throw new HTTPException(400, { message: '缺少 cookie 字段' })

  const inspection = inspectTencentCookie(cookie)
  if (!inspection.ok) {
    return c.json({ ok: false, message: `Cookie 缺少必需字段：${inspection.missing.join(', ')}` }, 400)
  }

  const result = await addBackupCookie(c.env, cookie, label)
  return c.json({
    ok: true,
    duplicated: result.duplicated,
    backup: { id: result.backup.id, label: result.backup.label },
    backupCount: result.total,
    warnings: inspection.warnings
  })
}

export const deleteBackup = async (c) => {
  requireAdmin(c)
  const id = c.req.query('id')
  if (!id) throw new HTTPException(400, { message: '缺少 id 参数' })
  const result = await removeBackupCookie(c.env, id)
  return c.json({ ok: result.removed, backupCount: result.total })
}

export const postRotate = async (c) => {
  requireAdmin(c)
  const result = await forceRotate(c.env)
  if (!result.rotated) {
    return c.json({ ok: false, message: result.message }, 400)
  }
  return c.json({ ok: true, ...result })
}

export const postCheck = async (c) => {
  requireAdmin(c)
  const result = await maintainCookie(c.env, { trigger: 'admin' })
  const data = await snapshot(c.env)
  return c.json({
    ok: true,
    action: result.action,
    status: result.status,
    alertSent: Boolean(result.alert),
    state: {
      status: data.status,
      activeSource: data.activeSource,
      reason: data.reason,
      lastCheck: data.lastCheck,
      backupCount: data.backupCount
    }
  })
}

export const postReset = async (c) => {
  requireAdmin(c)
  try {
    const result = await resetCookieState(c.env)
    return c.json({ ok: true, ...result })
  } catch (error) {
    return c.json({ ok: false, message: error.message }, 400)
  }
}

export const getBackups = async (c) => {
  requireAdmin(c)
  const list = await listBackups(c.env)
  return c.json({
    ok: true,
    total: list.length,
    backups: list.map(item => ({
      id: item.id,
      label: item.label,
      uin: maskCookie(item.cookie).replace(/key=.*/, ''),
      addedAt: item.addedAt,
      source: item.source
    }))
  })
}

export const getWebhook = async (c) => {
  requireAdmin(c)
  const url = await resolveWebhook(c.env)
  return c.json({ ok: true, configured: Boolean(url), webhook: maskWebhook(url) })
}

export const postWebhook = async (c) => {
  requireAdmin(c)
  const body = await readBody(c)
  const url = body.url || c.req.query('url')
  try {
    const saved = await setWebhook(c.env, url)
    return c.json({ ok: true, configured: Boolean(saved), webhook: maskWebhook(saved) })
  } catch (error) {
    return c.json({ ok: false, message: error.message }, 400)
  }
}

export const postTestAlert = async (c) => {
  requireAdmin(c)
  const content = [
    '## ✅ 企业微信告警测试',
    `> 时间：${formatTime()}`,
    '> 说明：收到这条消息代表 Cookie 失效提醒通道正常',
    '> 触发：手动测试'
  ].join('\n')

  const result = await sendWecom(c.env, content)
  return c.json({ ok: result.sent, result })
}
