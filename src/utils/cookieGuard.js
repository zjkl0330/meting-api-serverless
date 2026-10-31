import { refreshQQCookie, refreshTencentCookie } from './refresher.js'
import {
  STATUS,
  getState,
  saveState,
  getPrimaryCookie,
  getActiveCookie,
  savePrimaryCookie,
  rotateToBackup,
  degradeToAnonymous,
  listBackups,
  pushEvent
} from './cookieStore.js'
import { notifyThrottled, formatTime } from './notify.js'
import { inspectTencentCookie, maskCookie } from './cookieFormat.js'
import { probeTencentPlayback, probeUpstreamHealth } from './probe.js'

const THROTTLE = {
  invalid: 30 * 60 * 1000,
  switched: 10 * 60 * 1000,
  anonymous: 30 * 60 * 1000,
  recovered: 5 * 60 * 1000,
  unconfigured: 12 * 60 * 60 * 1000
}

let running = null

const statusUrl = (env) => {
  const base = env?.METING_URL
  if (!base) return ''
  return `${String(base).replace(/\/$/, '')}/status`
}

const adviceLines = (env) => {
  const url = statusUrl(env)
  const lines = ['> 处理建议：重新登录 QQ 音乐复制 Cookie 后调用 `POST /admin/cookie` 更新']
  if (url) lines.push(`> 状态面板：${url}`)
  return lines.join('\n')
}

function buildDownContent ({ env, action, reason, backupLeft, uin }) {
  const titles = {
    anonymous: '## ⚠️ QQ 音乐 Cookie 已失效（已临时降级）',
    invalid: '## ⚠️ QQ 音乐 Cookie 已失效',
    rotated: '## ⚠️ QQ 音乐 Cookie 已失效（已切换备用）'
  }

  const handles = {
    anonymous: '> 处理：没有可用备用 Cookie，已临时降级为匿名模式',
    invalid: '> 处理：已标记失效，未启用匿名降级',
    rotated: `> 处理：已自动切换备用 Cookie，剩余 ${backupLeft} 个`
  }

  const impacts = {
    anonymous: '> 影响：VIP 曲目暂时无法播放，普通曲目仍可播放',
    invalid: '> 影响：VIP 曲目暂时无法播放',
    rotated: '> 影响：播放已由备用 Cookie 接管，VIP 曲目仍可播放'
  }

  return [
    titles[action] || titles.invalid,
    `> 时间：${formatTime()}`,
    `> 账号：${uin || '未知'}`,
    `> 原因：${reason || 'Cookie 已失效'}`,
    handles[action] || handles.invalid,
    impacts[action] || impacts.invalid,
    adviceLines(env)
  ].join('\n')
}

function buildRecoveredContent ({ env, uin, reason }) {
  return [
    '## ✅ QQ 音乐 Cookie 已恢复',
    `> 时间：${formatTime()}`,
    `> 账号：${uin || '未知'}`,
    `> 说明：${reason || '主 Cookie 续期成功，已切回主 Cookie'}`,
    statusUrl(env) ? `> 状态面板：${statusUrl(env)}` : ''
  ].filter(Boolean).join('\n')
}

async function handleInvalid (env, state, result, trigger) {
  const now = Date.now()
  const reason = result?.message || 'Cookie 失效'
  const failures = (state.failures || 0) + 1
  const uin = inspectTencentCookie(await getPrimaryCookie(env)).uin
  const backupCount = (await listBackups(env)).length

  // 已在降级状态：不重复切换，只记录并限频提醒
  if (state.status === STATUS.DEGRADED) {
    await saveState(env, {
      failures,
      reason,
      lastCheck: { at: now, ok: false, reason, code: result?.code ?? null }
    })

    const shouldRotate = trigger === 'runtime' && failures >= 2 && backupCount > 0
    if (shouldRotate) {
      const rotated = await rotateToBackup(env)
      if (rotated) {
        await pushEvent(env, { type: 'switch', message: `当前备用失效，切换到 ${rotated.backup.label}` })
        const alert = await notifyThrottled(env, {
          key: 'cookie_switched',
          content: buildDownContent({ env, action: 'rotated', reason, backupLeft: rotated.remaining, uin }),
          throttleMs: THROTTLE.switched
        })
        return {
          status: STATUS.DEGRADED,
          action: 'rotated',
          changed: true,
          cookie: rotated.cookie,
          alert: alert.sent
        }
      }
    }

    const alert = await notifyThrottled(env, {
      key: 'cookie_invalid',
      content: buildDownContent({ env, action: 'rotated', reason, backupLeft: backupCount, uin }),
      throttleMs: THROTTLE.invalid
    })
    return { status: STATUS.DEGRADED, action: 'none', changed: false, alert: alert.sent, throttled: Boolean(alert.throttled) }
  }

  if (state.status === STATUS.ANONYMOUS) {
    // 匿名期间如果补进了备用 Cookie，立刻接管播放
    if (backupCount > 0) {
      const rotated = await rotateToBackup(env)
      if (rotated) {
        await saveState(env, {
          failures,
          reason,
          lastCheck: { at: now, ok: false, reason, code: result?.code ?? null }
        })
        await pushEvent(env, { type: 'switch', message: `匿名状态下补入备用，切换到 ${rotated.backup.label}` })
        const alert = await notifyThrottled(env, {
          key: 'cookie_switched',
          content: buildDownContent({ env, action: 'rotated', reason, backupLeft: rotated.remaining, uin }),
          throttleMs: THROTTLE.switched
        })
        return {
          status: STATUS.DEGRADED,
          action: 'rotated',
          changed: true,
          cookie: rotated.cookie,
          alert: alert.sent
        }
      }
    }

    await saveState(env, {
      failures,
      reason,
      lastCheck: { at: now, ok: false, reason, code: result?.code ?? null }
    })
    const alert = await notifyThrottled(env, {
      key: 'cookie_anonymous',
      content: buildDownContent({ env, action: 'anonymous', reason, backupLeft: 0, uin }),
      throttleMs: THROTTLE.anonymous
    })
    return { status: STATUS.ANONYMOUS, action: 'none', changed: false, alert: alert.sent, throttled: Boolean(alert.throttled) }
  }

  // ok / invalid / unconfigured -> 尝试备用，其次匿名
  const rotated = await rotateToBackup(env)
  if (rotated) {
    await saveState(env, {
      status: STATUS.DEGRADED,
      activeSource: `backup:${rotated.backup.id}`,
      since: now,
      failures,
      reason,
      lastCheck: { at: now, ok: false, reason, code: result?.code ?? null }
    })
    await pushEvent(env, { type: 'switch', message: `主 Cookie 失效，切换到 ${rotated.backup.label}` })
    const alert = await notifyThrottled(env, {
      key: 'cookie_switched',
      content: buildDownContent({ env, action: 'rotated', reason, backupLeft: rotated.remaining, uin }),
      throttleMs: THROTTLE.switched
    })
    return {
      status: STATUS.DEGRADED,
      action: 'rotated',
      changed: true,
      cookie: rotated.cookie,
      alert: alert.sent
    }
  }

  const allowedAnonymous = String(env?.METING_ANONYMOUS_FALLBACK ?? '1') !== '0'
  if (allowedAnonymous) {
    await degradeToAnonymous(env, reason)
    await saveState(env, {
      failures,
      reason,
      lastCheck: { at: now, ok: false, reason, code: result?.code ?? null }
    })
    await pushEvent(env, { type: 'anonymous', message: '主 Cookie 失效且无备用，临时降级匿名' })
    const alert = await notifyThrottled(env, {
      key: 'cookie_anonymous',
      content: buildDownContent({ env, action: 'anonymous', reason, backupLeft: 0, uin }),
      throttleMs: THROTTLE.anonymous
    })
    return { status: STATUS.ANONYMOUS, action: 'anonymous', changed: true, cookie: '', alert: alert.sent }
  }

  await saveState(env, {
    status: STATUS.INVALID,
    activeSource: 'primary',
    since: state.status === STATUS.INVALID ? state.since : now,
    failures,
    reason,
    lastCheck: { at: now, ok: false, reason, code: result?.code ?? null }
  })
  await pushEvent(env, { type: 'invalid', message: reason })
  const alert = await notifyThrottled(env, {
    key: 'cookie_invalid',
    content: buildDownContent({ env, action: 'invalid', reason, backupLeft: 0, uin }),
    throttleMs: THROTTLE.invalid
  })
  return { status: STATUS.INVALID, action: 'invalid', changed: state.status !== STATUS.INVALID, alert: alert.sent }
}

/**
 * 续期失败但直链仍可用：保持可用状态，不降级、不告警
 */
async function handleProbeOk (env, state, probe, refreshResult) {
  const wasBad = [STATUS.INVALID, STATUS.ANONYMOUS].includes(state.status)
  const cookie = await getPrimaryCookie(env)

  await saveState(env, {
    status: STATUS.OK,
    activeSource: state.status === STATUS.DEGRADED ? state.activeSource : 'primary',
    since: wasBad ? Date.now() : (state.since || Date.now()),
    failures: 0,
    reason: '无法自动续期，但当前直链仍可用',
    lastCheck: {
      at: Date.now(),
      ok: true,
      reason: `续期失败（${refreshResult?.message || '未知原因'}），VIP 曲目探测通过`,
      probeMid: probe.mid
    }
  })

  if (wasBad) {
    await pushEvent(env, { type: 'recovered', message: 'Cookie 直链仍可用，已恢复播放' })
  }

  return { status: STATUS.OK, action: 'probe-ok', changed: wasBad, cookie }
}

async function handleOk (env, state, result) {
  const wasBad = [STATUS.INVALID, STATUS.ANONYMOUS, STATUS.DEGRADED].includes(state.status)
  const cookie = result?.cookie || await getPrimaryCookie(env)

  if (cookie) await savePrimaryCookie(env, cookie, { activate: true })
  await saveState(env, {
    status: STATUS.OK,
    activeSource: 'primary',
    since: wasBad ? Date.now() : (state.since || Date.now()),
    failures: 0,
    reason: '',
    lastCheck: { at: Date.now(), ok: true, reason: result?.message || '续期成功' }
  })

  if (wasBad) {
    await pushEvent(env, { type: 'recovered', message: '主 Cookie 恢复可用' })
    const uin = inspectTencentCookie(cookie).uin
    const alert = await notifyThrottled(env, {
      key: 'cookie_recovered',
      content: buildRecoveredContent({ env, uin, reason: '主 Cookie 续期成功，已切回主 Cookie' }),
      throttleMs: THROTTLE.recovered
    })
    return { status: STATUS.OK, action: 'recovered', changed: true, cookie, alert: alert.sent }
  }

  return { status: STATUS.OK, action: 'none', changed: false, cookie }
}

async function runMaintain (env, { trigger = 'cron' } = {}) {
  const state = await getState(env)
  const primary = await getPrimaryCookie(env)

  if (!primary) {
    if (state.status !== STATUS.UNCONFIGURED) {
      await saveState(env, {
        status: STATUS.UNCONFIGURED,
        activeSource: 'none',
        reason: '未配置 Cookie',
        lastCheck: { at: Date.now(), ok: false, reason: '未配置 Cookie' }
      })
      await pushEvent(env, { type: 'unconfigured', message: '未配置 Cookie' })
    }
    return { status: STATUS.UNCONFIGURED, action: 'none', changed: false, cookie: '' }
  }

  const result = await refreshQQCookie(env)

  if (result.ok) return handleOk(env, state, result)

  if (result.invalid) {
    // 续期失败不等于 Cookie 立刻不能播：
    // 浏览器复制的 Cookie 常常没有 refresh_token，但 musickey 仍然有效。
    const probe = await probeTencentPlayback(env, primary)
    if (probe.ok) {
      const kept = await handleProbeOk(env, state, probe, result)
      return kept
    }
    // 探测失败分两种：请求异常（网络/风控）与确认无直链。
    // 请求异常时先用匿名免费曲确认上游健康，上游本身抽风就不判失效，等下一轮。
    if (probe.transient) {
      const health = await probeUpstreamHealth(env)
      if (!health.healthy) {
        await saveState(env, {
          lastCheck: { at: Date.now(), ok: false, reason: '上游异常（风控/网络），跳过本轮失效判定', unknown: true }
        })
        await pushEvent(env, { type: 'upstream', message: '上游异常，已跳过本轮失效判定' })
        return {
          status: state.status,
          action: 'unknown',
          changed: false,
          cookie: await getActiveCookie(env)
        }
      }
    }
    return handleInvalid(env, state, result, trigger)
  }

  // 网络异常：只更新检查时间，维持原状态，避免误报
  await saveState(env, {
    lastCheck: { at: Date.now(), ok: false, reason: result.message, unknown: true }
  })
  return {
    status: state.status,
    action: 'unknown',
    changed: false,
    cookie: await getActiveCookie(env),
    message: result.message
  }
}

/**
 * 定时任务 / 手动检查入口，进程内串行，避免并发重复轮换
 */
export async function maintainCookie (env, options = {}) {
  if (running) return running
  running = runMaintain(env, options).finally(() => { running = null })
  return running
}

/**
 * 播放失败（直链为空）时调用：限频做一次体检，必要时切换 Cookie
 */
export async function recoverCookie (env, { reason = 'url_empty', minIntervalMs = 120000, trigger = 'runtime' } = {}) {
  const state = await getState(env)
  const lastTry = state.lastRecoveryAt || 0
  const now = Date.now()

  // 用独立的恢复时间戳做节流，不能用 lastCheck：刚写入/刚检查过也会被挡住
  if (now - lastTry < minIntervalMs) {
    return {
      status: state.status,
      action: 'cooldown',
      changed: false,
      cookie: await getActiveCookie(env)
    }
  }

  await saveState(env, { lastRecoveryAt: now })
  const result = await maintainCookie(env, { trigger })
  return {
    ...result,
    reason
  }
}

/**
 * 管理端：写入新 Cookie 并立即验证
 */
export async function applyPrimaryCookie (env, cookie, { label = '', test = true } = {}) {
  const normalized = String(cookie || '').trim()
  if (!normalized) throw new Error('Cookie 不能为空')

  const inspection = inspectTencentCookie(normalized)
  if (!inspection.ok) {
    throw new Error(`Cookie 缺少必需字段：${inspection.missing.join(', ')}`)
  }

  let verification = null
  if (test) {
    if (inspection.canRefresh) {
      verification = await refreshTencentCookie(env, normalized)
      if (!verification.ok) {
        const error = new Error(verification.message || 'Cookie 验证失败')
        error.details = verification
        throw error
      }
    } else {
      // 浏览器复制的 Cookie 经常没有 refresh_token，无法续期但可能仍可播放
      const probe = await probeTencentPlayback(env, normalized)
      if (!probe.ok) {
        const error = new Error('Cookie 无法续期，且 VIP 曲目探测失败，可能已失效（确认可用可传 "test": false 强制写入）')
        error.details = probe
        throw error
      }
      verification = { ok: true, message: 'Cookie 无 refresh_token，跳过续期；VIP 直链探测通过' }
    }
  }

  const finalCookie = verification?.ok && verification.cookie ? verification.cookie : normalized
  await savePrimaryCookie(env, finalCookie, { label, activate: true })
  await saveState(env, {
    status: STATUS.OK,
    activeSource: 'primary',
    since: Date.now(),
    failures: 0,
    reason: '',
    lastCheck: { at: Date.now(), ok: true, reason: verification?.message || '手动写入' }
  })
  await pushEvent(env, { type: 'update', message: label ? `主 Cookie 已更新（${label}）` : '主 Cookie 已更新' })

  return { state: await getState(env), inspection, verification: verification ? { ok: verification.ok, message: verification.message } : null }
}

/**
 * 管理端：强制切到下一个备用
 */
export async function forceRotate (env) {
  const rotated = await rotateToBackup(env)
  if (!rotated) return { rotated: false, message: '没有可用备用 Cookie' }

  await saveState(env, {
    status: STATUS.DEGRADED,
    activeSource: `backup:${rotated.backup.id}`,
    since: Date.now(),
    failures: 0,
    reason: '手动切换备用',
    lastCheck: { at: Date.now(), ok: true, reason: '手动切换' }
  })
  await pushEvent(env, { type: 'switch', message: `手动切换到 ${rotated.backup.label}` })

  const uin = inspectTencentCookie(rotated.cookie).uin
  await notifyThrottled(env, {
    key: 'cookie_switched',
    content: buildDownContent({ env, action: 'rotated', reason: '手动切换备用 Cookie', backupLeft: rotated.remaining, uin }),
    throttleMs: THROTTLE.switched
  })

  return { rotated: true, remaining: rotated.remaining, backup: { id: rotated.backup.id, label: rotated.backup.label } }
}

/**
 * 管理端：清除失效标记，重新以主 Cookie 为准
 */
export async function resetCookieState (env) {
  const primary = await getPrimaryCookie(env)
  if (!primary) throw new Error('尚未配置主 Cookie')
  await savePrimaryCookie(env, primary, { activate: true })
  await saveState(env, {
    status: STATUS.OK,
    activeSource: 'primary',
    since: Date.now(),
    failures: 0,
    reason: '手动复位',
    lastCheck: null
  })
  await pushEvent(env, { type: 'reset', message: '手动复位 Cookie 状态' })
  return { status: STATUS.OK, cookie: maskCookie(primary) }
}
