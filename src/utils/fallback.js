import { createMeting } from './metingFactory.js'

const CANDIDATE_LIMIT = 10
const TRY_URL_LIMIT = 3
const CALL_TIMEOUT_MS = 8000

const withTimeout = (promise, ms = CALL_TIMEOUT_MS) => {
  if (typeof setTimeout === 'undefined') return promise
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('上游超时')), ms))
  ])
}

export const normalizeTitle = (value) => String(value || '')
  .toLowerCase()
  .replace(/\([^)]*\)|（[^）]*）|\[[^\]]*\]|【[^】]*】/g, '')
  .replace(/feat\..*$|ft\..*$/g, '')
  .replace(/[\s\-_·.,，。!！?？'"“”‘’~～、/\\|&+]/g, '')

export const normalizeArtist = (value) => String(value || '')
  .toLowerCase()
  .replace(/[\s\-_·.,，。!！?？'"“”‘’~～、/\\|&+]/g, '')

export function scoreCandidate (meta, candidate, { requireArtist = false } = {}) {
  const title = normalizeTitle(meta.name)
  const candTitle = normalizeTitle(candidate.name)
  if (!title || !candTitle) return -1

  const exact = title === candTitle
  const contains = !exact && (candTitle.includes(title) || title.includes(candTitle))
  if (!exact && !contains) return -1

  const sourceArtists = (meta.artist || []).map(normalizeArtist).filter(Boolean)
  const candArtists = (candidate.artist || []).map(normalizeArtist).filter(Boolean)
  const artistMatch = sourceArtists.some(s => candArtists.some(c => c === s || c.includes(s) || s.includes(c)))

  if (requireArtist && !artistMatch) return -1

  let score = exact ? 3 : 1
  if (artistMatch) score += 3

  // 明显是翻唱/伴奏/片段时降权
  if (/翻唱|cover|伴奏|instrumental|remix|dj|片段|铃声/i.test(candidate.name)) score -= 2

  return score
}

async function fetchMeta (server, id) {
  const meting = createMeting(server)
  const raw = await withTimeout(meting.song(id))
  const list = JSON.parse(raw)
  const first = Array.isArray(list) ? list[0] : null
  if (!first || !first.name) return null
  return { name: first.name, artist: first.artist || [] }
}

const pickName = (item) => item?.name || item?.songname || item?.songName || item?.title || ''
const pickId = (item) => item?.id ?? item?.mid ?? item?.hash ?? null
const pickArtists = (item) => {
  if (Array.isArray(item?.artist)) return item.artist.filter(Boolean)
  if (Array.isArray(item?.ar)) return item.ar.map(a => a?.name).filter(Boolean)
  if (Array.isArray(item?.singer)) return item.singer.map(a => a?.name).filter(Boolean)
  if (typeof item?.singername === 'string') return item.singername.split(/[&,、]/).map(s => s.trim()).filter(Boolean)
  return []
}

const RAW_LIST_PATH = {
  netease: (raw) => raw?.result?.songs,
  tencent: (raw) => raw?.data?.song?.list,
  kugou: (raw) => raw?.data?.info
}

/**
 * 搜索候选：优先用 @meting/core 的格式化输出；
 * 上游返回部分脏数据导致 format 抛错时，退回原始 JSON 自己映射，避免整次兜底失败。
 */
async function searchCandidates (target, keyword) {
  try {
    const meting = createMeting(target)
    const parsed = JSON.parse(await withTimeout(meting.search(keyword, { limit: CANDIDATE_LIMIT })))
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed
        .map(item => ({ name: item.name, artist: item.artist || [], url_id: item.url_id }))
        .filter(item => item.name && item.url_id)
    }
  } catch (error) {
    console.warn(`[fallback] ${target} 格式化搜索失败，改用原始数据:`, error?.message)
  }

  const picker = RAW_LIST_PATH[target]
  if (!picker) return []

  const meting = createMeting(target)
  meting.format(false)
  const raw = JSON.parse(await withTimeout(meting.search(keyword, { limit: CANDIDATE_LIMIT })))
  const list = picker(raw)
  if (!Array.isArray(list)) return []

  return list
    .map(item => ({ name: pickName(item), artist: pickArtists(item), url_id: pickId(item) }))
    .filter(item => item.name && item.url_id)
}

async function tryServer (target, meta, requireArtist, { excludeIds = [] } = {}) {
  const keyword = [meta.name, meta.artist?.[0]].filter(Boolean).join(' ')
  const list = await searchCandidates(target, keyword)
  if (list.length === 0) return null

  const skip = new Set(excludeIds.map(String))
  const ranked = list
    .filter(item => !skip.has(String(item.url_id)))
    .map(item => ({ item, score: scoreCandidate(meta, item, { requireArtist }) }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, TRY_URL_LIMIT)

  for (const { item, score } of ranked) {
    try {
      const player = createMeting(target)
      const urlRaw = await withTimeout(player.url(item.url_id))
      const data = JSON.parse(urlRaw)
      if (data?.url) {
        return {
          url: data.url,
          target,
          match: score >= 6 ? 'exact' : 'loose',
          matched: {
            name: item.name,
            artist: item.artist || [],
            urlId: item.url_id
          }
        }
      }
    } catch (error) {
      // 单曲失败继续尝试下一首
    }
  }

  return null
}

/**
 * 主平台直链拿不到时依次尝试：
 * 1. 同平台换版本（同一首歌的不同 mid 授权状态不同，实测 VIP 曲目也存在可匿名播放的版本）
 * 2. 跨平台找同名可播版本（METING_FALLBACK_SERVERS 控制，默认 netease）
 */
export async function findUrlFallback (server, id, env) {
  const configured = env?.METING_FALLBACK_SERVERS ?? 'netease'
  const targets = String(configured)
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(item => ['netease', 'tencent', 'kugou', 'kuwo', 'baidu'].includes(item) && item !== server)

  const sameServerTry = String(env?.METING_SAME_SERVER_RETRY ?? '1') === '1'
  if (!sameServerTry && targets.length === 0) return null

  const requireArtist = String(env?.METING_FALLBACK_STRICT_ARTIST ?? '0') === '1'

  let meta
  try {
    meta = await fetchMeta(server, id)
  } catch (error) {
    console.warn('[fallback] 获取歌曲信息失败:', error?.message)
    return null
  }
  if (!meta) return null

  const source = { name: meta.name, artist: meta.artist }

  if (sameServerTry) {
    try {
      const found = await tryServer(server, meta, requireArtist, { excludeIds: [String(id)] })
      if (found) return { ...found, sameServer: true, source }
    } catch (error) {
      console.warn(`[fallback] ${server} 同平台换版本失败:`, error?.message)
    }
  }

  for (const target of targets) {
    try {
      const found = await tryServer(target, meta, requireArtist, { excludeIds: [String(id)] })
      if (found) return { ...found, source }
    } catch (error) {
      console.warn(`[fallback] ${target} 兜底失败:`, error?.message)
    }
  }

  return null
}
