/**
 * 极简 KV 抽象：
 * - Cloudflare Workers / 绑定 KV 时使用真实 KV
 * - Vercel / 未绑定 KV 时退化为进程内存（单实例有效，重启即丢失）
 *
 * 所有值统一按字符串存取，JSON 由上层封装。
 */
const memory = new Map()

export const hasKv = (env) => Boolean(env && env.METING_KV)

export async function kvGet (env, key) {
  if (hasKv(env)) {
    try {
      return await env.METING_KV.get(key)
    } catch (error) {
      console.warn('[store] KV get 失败，回退内存:', key, error?.message)
    }
  }
  return memory.has(key) ? memory.get(key) : null
}

export async function kvPut (env, key, value) {
  if (hasKv(env)) {
    try {
      await env.METING_KV.put(key, value)
      memory.set(key, value)
      return
    } catch (error) {
      console.warn('[store] KV put 失败，仅写内存:', key, error?.message)
    }
  }
  memory.set(key, value)
}

export async function kvDelete (env, key) {
  memory.delete(key)
  if (hasKv(env)) {
    try {
      await env.METING_KV.delete(key)
    } catch (error) {
      console.warn('[store] KV delete 失败:', key, error?.message)
    }
  }
}

export async function getJson (env, key, fallback = null) {
  const raw = await kvGet(env, key)
  if (!raw) return fallback
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

export async function putJson (env, key, value) {
  await kvPut(env, key, JSON.stringify(value))
}

/** 仅用于测试：清空内存态 */
export function __resetMemoryStore () {
  memory.clear()
}
