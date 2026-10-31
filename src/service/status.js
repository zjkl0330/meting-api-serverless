import { snapshot } from '../utils/cookieStore.js'
import { resolveWebhook, maskWebhook } from '../utils/notify.js'

const LABELS = {
  ok: '正常',
  degraded: '降级（使用备用 Cookie）',
  anonymous: '匿名模式（VIP 不可用）',
  invalid: '失效',
  unconfigured: '未配置'
}

const COLORS = {
  ok: '#0f9d58',
  degraded: '#f4b400',
  anonymous: '#db4437',
  invalid: '#db4437',
  unconfigured: '#888888'
}

const isAdmin = (c) => {
  const expected = c.env?.METING_ADMIN_TOKEN || c.env?.METING_TOKEN || 'token'
  const provided = c.req.query('token') || (c.req.header('authorization') || '').replace(/^Bearer\s+/i, '')
  return Boolean(provided) && provided === expected
}

const publicView = (data, webhookConfigured) => ({
  status: data.status,
  label: LABELS[data.status] || data.status,
  activeSource: data.activeSource,
  reason: data.reason,
  since: data.since,
  updatedAt: data.updatedAt,
  lastCheck: data.lastCheck,
  failures: data.failures,
  backupCount: data.backupCount,
  webhookConfigured
})

const renderHtml = (data, env, full) => {
  const color = COLORS[data.status] || '#888'
  const checked = data.lastCheck?.at ? new Date(data.lastCheck.at + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19) : '—'
  const events = (data.events || []).slice(0, 8).map(item => {
    const at = new Date((item.at || 0) + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19)
    return `<li><time>${at}</time><span>${escapeHtml(item.message || item.type || '')}</span></li>`
  }).join('')

  const backups = (data.backups || []).map(item => `<li>${escapeHtml(item.label || item.id)} · uin ${escapeHtml(item.uin || '?')}</li>`).join('')

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Meting 状态</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 32px 20px; font: 15px/1.7 -apple-system, "Segoe UI", "PingFang SC", sans-serif;
         background: #f6f7f9; color: #1f2328; }
  .wrap { max-width: 720px; margin: 0 auto; }
  .card { background: #fff; border-radius: 14px; padding: 22px 24px; box-shadow: 0 1px 3px rgba(0,0,0,.06); margin-bottom: 16px; }
  h1 { font-size: 18px; margin: 0 0 14px; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 999px; color: #fff; font-size: 13px; }
  dl { display: grid; grid-template-columns: 110px 1fr; gap: 8px 12px; margin: 16px 0 0; }
  dt { color: #6b7280; }
  dd { margin: 0; word-break: break-all; }
  ul { margin: 8px 0 0; padding-left: 18px; }
  li { margin: 4px 0; }
  time { color: #6b7280; margin-right: 8px; font-variant-numeric: tabular-nums; }
  code { background: #f2f3f5; padding: 1px 5px; border-radius: 4px; font-size: 13px; }
  @media (prefers-color-scheme: dark) {
    body { background: #16181c; color: #e6e6e6; }
    .card { background: #1e2126; box-shadow: none; }
    dt { color: #9aa0a6; }
    code { background: #2a2d33; }
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <h1>QQ 音乐 Cookie 状态 <span class="badge" style="background:${color}">${escapeHtml(data.label || LABELS[data.status] || data.status)}</span></h1>
    <dl>
      <dt>生效来源</dt><dd>${escapeHtml(data.activeSource || '—')}</dd>
      <dt>最近检查</dt><dd>${checked} (UTC+8)</dd>
      <dt>失效原因</dt><dd>${escapeHtml(data.reason || '—')}</dd>
      <dt>备用 Cookie</dt><dd>${data.backupCount} 个</dd>
      <dt>企业微信</dt><dd>${data.webhookConfigured ? '已配置' : '未配置'}</dd>
    </dl>
  </div>
  ${data.backups && data.backups.length ? `<div class="card"><h1>备用池</h1><ul>${backups}</ul></div>` : ''}
  <div class="card">
    <h1>最近事件</h1>
    <ul>${events || '<li>暂无</li>'}</ul>
  </div>
  <div class="card">
    <h1>更新 Cookie</h1>
    <p>部署后执行：</p>
    <code>curl -X POST "https://你的域名/admin/cookie?token=你的METING_TOKEN" -H "Content-Type: application/json" -d '{"cookie":"完整的QQ音乐Cookie"}'</code>
    <p>更多参数见 README。</p>
  </div>
</div>
</body>
</html>`
}

const escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

export default async (c) => {
  const data = await snapshot(c.env)
  const webhook = await resolveWebhook(c.env)
  const full = isAdmin(c)

  const view = full
    ? { ...publicView(data, Boolean(webhook)), ...data, webhook: maskWebhook(webhook) }
    : publicView(data, Boolean(webhook))

  view.label = LABELS[data.status] || data.status

  const wantsHtml = c.req.query('format') === 'html' ||
    (c.req.header('accept') || '').includes('text/html')

  if (wantsHtml) {
    // 非管理员只展示公共字段，避免把备用账号 uin 暴露给任意访客
    const htmlData = full
      ? { ...data, ...view }
      : { ...view, events: data.events, backups: [] }
    return c.html(renderHtml(htmlData, c.env, full))
  }

  return c.json(view)
}
