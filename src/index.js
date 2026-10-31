import { createApp } from './app.js'
import { stripPrefix } from './utils/prefix.js'
import { maintainCookie } from './utils/cookieGuard.js'

const app = createApp()

export default {
  async fetch (request, env, ctx) {
    const normalizedRequest = stripPrefix(request, env)
    return app.fetch(normalizedRequest, env, ctx)
  },
  async scheduled (event, env, ctx) {
    // 续期 + 失效自动切换备用/匿名 + 企业微信提醒
    ctx.waitUntil(maintainCookie(env, { trigger: 'cron' }))
  }
}
