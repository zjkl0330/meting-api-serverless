import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { requestLogger } from './middleware/logger.js'
import errors from './middleware/errors.js'
import apiService from './service/api.js'
import demoService from './service/demo.js'
import statusService from './service/status.js'
import {
  postCookie,
  postBackup,
  deleteBackup,
  postRotate,
  postCheck,
  postReset,
  getBackups,
  getWebhook,
  postWebhook,
  postTestAlert
} from './service/admin.js'
import { maintainCookie } from './utils/cookieGuard.js'
import { getState } from './utils/cookieStore.js'

export const createApp = () => {
  const app = new Hono()
    .use(cors())
    .use(requestLogger)
    .use(errors)

  app.get('/api', apiService)
  app.get('/demo', demoService)

  // 状态面板：浏览器直接打开是 HTML，程序请求返回 JSON
  app.get('/status', statusService)

  // 健康检查：服务在线即 200，Cookie 状态放在 body
  app.get('/health', async (c) => {
    const state = await getState(c.env)
    return c.json({
      ok: true,
      cookie: state.status,
      activeSource: state.activeSource,
      lastCheck: state.lastCheck
    })
  })

  // 手动触发续期 + 失效处理（保留原有无鉴权行为，便于原有调用方使用）
  app.get('/refresh', async (c) => {
    const result = await maintainCookie(c.env, { trigger: 'http' })
    return c.json(result)
  })

  // 管理接口（token 鉴权）
  app.get('/admin/cookie/backups', getBackups)
  app.post('/admin/cookie', postCookie)
  app.post('/admin/cookie/backup', postBackup)
  app.delete('/admin/cookie/backup', deleteBackup)
  app.post('/admin/cookie/rotate', postRotate)
  app.post('/admin/cookie/check', postCheck)
  app.post('/admin/cookie/reset', postReset)
  app.get('/admin/webhook', getWebhook)
  app.post('/admin/webhook', postWebhook)
  app.post('/admin/alert/test', postTestAlert)

  return app
}

export default createApp
