import { createMeting } from './metingFactory.js'

/**
 * 探测用歌曲：都是 QQ 音乐 VIP 曲目，匿名请求拿不到直链。
 * 只要其中任意一首能拿到直链，说明 Cookie 仍然有效（只是可能无法自动续期）。
 */
export const DEFAULT_PROBE_MIDS = [
  '003OUlho2HcRHC', // 告白气球
  '0039MnYb0qxYhV', // 晴天
  '004Z8Ihr0JIu5s' // 七里香
]

/**
 * 上游健康基线：匿名就能拿到完整直链的免费曲目。
 * 判定 Cookie 失效前先用它确认上游本身没抽风——
 * QQ 风控（code=2001）会让续期、探测同时失败，不区分会把好 Cookie 误判成失效。
 */
export const DEFAULT_HEALTH_MIDS = [
  '002f6kjO3yqwfd', // 晴天（可匿名播放版本）
  '003OUlho2HcRHC' // 告白气球（备用）
]

const resolveMids = (env) => {
  const configured = env?.METING_HEALTH_PROBE_MIDS
  if (!configured) return DEFAULT_PROBE_MIDS
  const list = String(configured).split(',').map(item => item.trim()).filter(Boolean)
  return list.length > 0 ? list : DEFAULT_PROBE_MIDS
}

const resolveHealthMids = (env) => {
  const configured = env?.METING_HEALTH_BASELINE_MIDS
  if (!configured) return DEFAULT_HEALTH_MIDS
  const list = String(configured).split(',').map(item => item.trim()).filter(Boolean)
  return list.length > 0 ? list : DEFAULT_HEALTH_MIDS
}

const withTimeout = (promise, ms = 12000) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('probe timeout')), ms))])

/**
 * 用 VIP 曲目试探 Cookie 是否还能取到播放地址。
 * 返回 { ok, mid } / { ok:false, reason, transient }
 * transient=true 表示异常来自网络/上游（有请求抛错），不能据此判定 Cookie 失效；
 * transient=false 表示每首都是明确返回空直链，可以确认 Cookie 拿不到。
 */
export async function probeTencentPlayback (env, cookie) {
  if (!cookie) return { ok: false, reason: 'no_cookie', checked: 0, transient: false }

  const mids = resolveMids(env)
  let transient = false
  for (const mid of mids) {
    try {
      const data = JSON.parse(await withTimeout(createMeting('tencent', cookie).url(mid)))
      if (data?.url) return { ok: true, mid, checked: mids.indexOf(mid) + 1, transient: false }
      // 明确的空直链：继续验证下一首
    } catch (error) {
      // 请求本身抛错（网络/超时/风控报文），标记 transient 但继续把剩余曲目试完
      transient = true
    }
  }

  return { ok: false, reason: transient ? 'upstream_error' : 'no_playable_url', checked: mids.length, transient }
}

/**
 * 上游健康检查：匿名请求免费曲目。
 * 任一命中 => 上游正常（此时 Cookie 拿不到 VIP 才能归因于 Cookie）；
 * 全部失败 => 上游风控/故障，本轮判定作废。
 */
export async function probeUpstreamHealth (env) {
  for (const mid of resolveHealthMids(env)) {
    try {
      const data = JSON.parse(await withTimeout(createMeting('tencent').url(mid)))
      if (data?.url) return { healthy: true, mid }
    } catch (error) {
      // 继续下一首
    }
  }
  return { healthy: false }
}
