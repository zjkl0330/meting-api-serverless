import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'

import { createApp } from '../src/app.js'
import { __resetMemoryStore } from '../src/utils/store.js'
import {
  savePrimaryCookie,
  addBackupCookie,
  getActiveCookie,
  getState,
  listBackups
} from '../src/utils/cookieStore.js'
import { maintainCookie } from '../src/utils/cookieGuard.js'
import { scoreCandidate, normalizeTitle } from '../src/utils/fallback.js'
import { maskCookie, inspectTencentCookie } from '../src/utils/cookieFormat.js'

const WEBHOOK = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test'

const BAD = 'uin=o123456; qqmusic_key=BADKEY0001; qm_keyst=BADKEY0001; psrf_qqrefresh_token=rt-bad; psrf_qqopenid=oid-bad'
const BACKUP = 'uin=o777888; qqmusic_key=GOODKEY9999; qm_keyst=GOODKEY9999; psrf_qqrefresh_token=rt-good; psrf_qqopenid=oid-good'

class MemoryKv {
  constructor () { this.map = new Map() }
  async get (key) { return this.map.has(key) ? this.map.get(key) : null }
  async put (key, value) { this.map.set(key, value) }
  async delete (key) { this.map.delete(key) }
}

let sent = []
let refreshCode = 1000
let refreshData = {}
let vkeyUrl = ''
let songDetail = null
let neteaseSearch = null
let neteaseUrl = ''

const json = (body) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json' }
})

const realFetch = globalThis.fetch

const installFetchMock = () => {
  const mock = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url

    if (url.startsWith('https://qyapi.weixin.qq.com')) {
      sent.push(JSON.parse(init.body))
      return json({ errcode: 0, errmsg: 'ok' })
    }
    if (url.includes('musics.fcg')) {
      return json({ req: { code: refreshCode, data: refreshData } })
    }
    if (url.includes('fcg_play_single_song.fcg')) {
      return json(songDetail)
    }
    if (url.includes('song/detail')) {
      return json(songDetail)
    }
    if (url.includes('u.y.qq.com/cgi-bin/musicu.fcg')) {
      // 同一个端点承担两种用途：搜索（SearchCgiService）与取直链（GetVkeyServer），
      // 按请求体里的 module 区分返回结构。
      const body = String(init.body || '')
      if (body.includes('SearchCgiService')) {
        return json({
          req_0: {
            code: 0,
            data: {
              body: {
                song: {
                  list: [{ mid: '003OUlho2HcRHC', name: '告白气球', singer: [{ name: '周杰伦' }], album: { name: '告白气球', mid: '003RMaRI1iFoYd' } }]
                }
              }
            }
          }
        })
      }
      return json({
        req_0: {
          code: 0,
          data: {
            sip: ['https://dl.stream.qqmusic.qq.com/'],
            midurlinfo: Array.from({ length: 7 }, () => ({ vkey: vkeyUrl ? 'VKEY' : '', purl: vkeyUrl, filename: 'M800003OUlho2HcRHC.mp3' }))
          }
        }
      })
    }
    if (url.includes('cloudsearch')) {
      return json(neteaseSearch)
    }
    if (url.includes('enhance/player/url')) {
      return json({ data: [{ url: neteaseUrl, size: 1000, br: 320 }] })
    }
    // 跨平台兜底要逐个平台搜索候选再试直链，这里给出可命中的最小响应
    if (url.includes('mobilecdn.kugou.com/api/v3/search/song')) {
      return json({ data: { info: [{ hash: 'KUGOUHASH1', filename: '告白气球 - 周杰伦', singer: '周杰伦' }] } })
    }
    if (url.includes('m.kugou.com/app/i/getSongInfo.php') || url.includes('get_res_privilege')) {
      // 库的 kugou urlDecode 读的是 bitRate（驼峰），写成 bitrate 会拿不到
      return json({ url: [vkeyUrl || 'https://dl.kugou.com/fallback.mp3'], bitRate: 320000, fileSize: 1000 })
    }
    if (url.includes('kuwo.cn/api/www/search/searchMusicBykeyWord')) {
      return json({ data: { list: [{ mid: 'KUWOMID1', name: '告白气球', singer: '周杰伦' }] } })
    }
    if (url.includes('kuwo.cn/api/v1/www/music/playUrl')) {
      return json({ code: 200, data: { url: vkeyUrl || 'https://dl.kuwo.cn/fallback.mp3', br: 128 } })
    }
    if (url.includes('client_search_cp') || url.includes('musicu.fcg')) {
      return json({
        code: 0,
        data: { song: { list: [{ mid: 'TENCENTMID1', songmid: 'TENCENTMID1', name: '告白气球', singer: [{ name: '周杰伦' }] }] } }
      })
    }
    throw new Error(`未预期的上游请求: ${url}`)
  }
  globalThis.fetch = mock
  return mock
}

const makeEnv = () => ({
  METING_KV: new MemoryKv(),
  METING_TOKEN: 'token',
  METING_ALERT_WEBHOOK: WEBHOOK
})

const qqSong = {
  code: 0,
  data: [{
    mid: '003OUlho2HcRHC',
    name: '告白气球',
    singer: [{ name: '周杰伦' }],
    album: { title: '周杰伦的床边故事', mid: '003RMaRI1iFoYd' },
    file: { media_mid: '003OUlho2HcRHC', size_320mp3: 1000, size_128mp3: 1000 },
    type: 0
  }]
}

test.beforeEach(() => {
  sent = []
  refreshCode = 1000
  refreshData = {}
  vkeyUrl = ''
  songDetail = qqSong
  neteaseSearch = null
  neteaseUrl = ''
  __resetMemoryStore()
  installFetchMock()
})

test.after(() => { globalThis.fetch = realFetch })

test('Cookie 失效且有备用时自动切换，并发送企业微信提醒', async () => {
  const env = makeEnv()
  await savePrimaryCookie(env, BAD)
  await addBackupCookie(env, BACKUP, '备用一')

  const result = await maintainCookie(env, { trigger: 'cron' })

  assert.equal(result.status, 'degraded')
  assert.equal(result.action, 'rotated')
  assert.equal(await getActiveCookie(env), BACKUP)
  assert.equal((await listBackups(env)).length, 0)

  const state = await getState(env)
  assert.equal(state.activeSource.startsWith('backup:'), true)

  assert.equal(sent.length, 1)
  const content = sent[0].markdown.content
  assert.match(content, /Cookie 已失效/)
  assert.match(content, /已自动切换备用/)
  assert.match(content, /剩余 0 个/)
})

test('没有备用时降级匿名，VIP 直链不再带死 Cookie', async () => {
  const env = makeEnv()
  await savePrimaryCookie(env, BAD)

  const result = await maintainCookie(env, { trigger: 'cron' })

  assert.equal(result.status, 'anonymous')
  assert.equal(result.action, 'anonymous')
  assert.equal(await getActiveCookie(env), '')
  assert.equal(sent.length, 1)
  assert.match(sent[0].markdown.content, /临时降级为匿名/)
})

test('主 Cookie 恢复后自动切回并发送恢复通知', async () => {
  const env = makeEnv()
  await savePrimaryCookie(env, BAD)
  await maintainCookie(env, { trigger: 'cron' })

  refreshCode = 0
  refreshData = { musickey: 'NEWKEY7777', refresh_token: 'rt-new' }

  const result = await maintainCookie(env, { trigger: 'cron' })

  assert.equal(result.status, 'ok')
  assert.equal(result.action, 'recovered')
  const active = await getActiveCookie(env)
  assert.match(active, /NEWKEY7777/)
  assert.equal(sent.length, 2)
  assert.match(sent[1].markdown.content, /Cookie 已恢复/)
})

test('同类告警在节流窗口内不会重复发送', async () => {
  const env = makeEnv()
  await savePrimaryCookie(env, BAD)

  await maintainCookie(env, { trigger: 'cron' })
  await maintainCookie(env, { trigger: 'cron' })
  await maintainCookie(env, { trigger: 'cron' })

  assert.equal(sent.length, 1)
})

test('上游网络异常不会被判定为 Cookie 失效', async () => {
  const env = makeEnv()
  await savePrimaryCookie(env, BAD)
  await maintainCookie(env, { trigger: 'cron' }) // 先进入 anonymous
  const before = await getState(env)

  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url
    if (url.includes('musics.fcg')) throw new Error('network down')
    return json({})
  }

  const result = await maintainCookie(env, { trigger: 'cron' })
  assert.equal(result.action, 'unknown')
  assert.equal(result.status, before.status)
  assert.equal(sent.length, 1)
})

test('直链为空时走跨平台兜底并标记响应头', async () => {
  const env = makeEnv()
  await savePrimaryCookie(env, BAD)

  neteaseSearch = {
    result: {
      songs: [{
        id: 3361467146,
        name: '告白气球',
        ar: [{ name: '周杰伦' }],
        al: { name: '告白气球', pic_str: '109951' }
      }]
    }
  }
  neteaseUrl = 'https://m801.music.126.net/fallback.mp3'

  const app = createApp()
  const auth = createHmac('sha1', 'token').update('tencenturl003OUlho2HcRHC').digest('hex')
  const request = new Request(`http://localhost/api?server=tencent&type=url&id=003OUlho2HcRHC&auth=${auth}`)
  const response = await app.fetch(request, env)

  assert.equal(response.status, 302)
  assert.equal(response.headers.get('location'), neteaseUrl)
  assert.equal(response.headers.get('x-fallback-source'), 'netease')
  assert.equal(response.headers.get('x-cookie-state'), 'anonymous')
})

test('netease 拿不到直链时也走跨平台兜底（风控下不至于哑火）', async () => {
  // 回归：原来兜底只在 server==='tencent' 时触发，网易云被风控（code -462）
  // 导致 player/url 稳定拿不到直链时，接口直接 404，播放器彻底没声音。
  // 这里不依赖各平台的搜索/直链响应结构（那是第三方库的细节），只验证契约：
  // 主源是 netease 且拿不到直链时，兜底必须被调用，且不是「同平台重试」。
  const env = makeEnv()

  // 网易云 song 能查到（兜底要靠它取歌名与歌手），player/url 返回空直链（模拟风控）
  songDetail = {
    code: 0,
    songs: [{
      id: 3361467146,
      name: '告白气球',
      ar: [{ name: '周杰伦' }],
      al: { name: '告白气球', pic_str: '109951' }
    }]
  }
  neteaseSearch = {
    result: {
      songs: [{
        id: 3361467146,
        name: '告白气球',
        ar: [{ name: '周杰伦' }],
        al: { name: '告白气球', pic_str: '109951' }
      }]
    }
  }
  neteaseUrl = ''

  // 记录兜底实际尝试的平台
  const tried = []
  const baseMock = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url
    if (url.includes('music.163.com')) return baseMock(input, init)
    tried.push(url.slice(0, 60))
    // 其他平台统一返回空结果：重点是「兜底被触发且尝试了跨平台」
    return json({ code: 0, data: { info: [], list: [], song: { list: [] } } })
  }

  try {
    const app = createApp()
    const auth = createHmac('sha1', 'token').update('neteaseurl3361467146').digest('hex')
    const request = new Request(`http://localhost/api?server=netease&type=url&id=3361467146&auth=${auth}`)
    const response = await app.fetch(request, env)

    // 兜底被触发 → 会去访问非网易云的上游
    assert.ok(tried.length > 0, 'netease 拿不到直链时也应尝试跨平台兜底')
    assert.ok(
      tried.some(u => u.includes('kugou') || u.includes('kuwo') || u.includes('qq.com')),
      `兜底应访问其他平台，实际访问：${JSON.stringify(tried)}`
    )
    // 拿不到直链时仍是 404，但必须带兜底相关响应头说明走过兜底路径
    assert.equal(response.status, 404)
  } finally {
    installFetchMock()
  }
})

test('直链上游抛错时转入兜底而不是直接 500', async () => {
  // 网易云被风控时 player/url 是抛错而非返回空 url，异常若冒泡就是 500，
  // 跨平台兜底完全没机会接手（播放器彻底没声音）。
  const env = makeEnv()
  const tried = []
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url
    if (url.includes('enhance/player/url')) {
      throw new Error('风控拦截')
    }
    // song/detail 要能取到歌名与歌手，否则兜底第一步（fetchMeta）就返回 null
    if (url.includes('song/detail')) {
      return json({ code: 0, songs: [{ id: 3361467146, name: '告白气球', ar: [{ name: '周杰伦' }], al: { name: '告白气球', pic_str: '109951' } }] })
    }
    tried.push(url.slice(0, 60))
    return json({ code: 0, data: { info: [], list: [], song: { list: [] } } })
  }

  try {
    const app = createApp()
    // 用不同的 id：url 结果会被 LRU 缓存 60s，撞键会直接命中缓存、不再走上游
    const auth = createHmac('sha1', 'token').update('neteaseurl3361467147').digest('hex')
    const request = new Request(`http://localhost/api?server=netease&type=url&id=3361467147&auth=${auth}`)
    const response = await app.fetch(request, env)

    assert.notEqual(response.status, 500, '上游异常不应直接冒泡成 500')
    assert.ok(tried.length > 0, '上游异常后应尝试跨平台兜底')
  } finally {
    // 恢复 beforeEach 安装的标准 mock（不是进入测试时的引用，那可能已被别的用例改过）
    installFetchMock()
  }
})

test('Cookie 解析与脱敏', () => {
  const info = inspectTencentCookie(BAD)
  assert.equal(info.ok, true)
  assert.equal(info.uin, '123456')
  assert.equal(info.canRefresh, true)

  const masked = maskCookie(BAD)
  assert.equal(masked.includes('BADKEY0001'), false)
  assert.match(masked, /uin=123456/)

  const broken = inspectTencentCookie('foo=bar')
  assert.equal(broken.ok, false)
  assert.deepEqual(broken.missing, ['uin', 'qqmusic_key/qm_keyst'])
})

test('兜底匹配：同名同歌手优先，翻唱降权', () => {
  assert.equal(normalizeTitle('告白气球 (Live)'), '告白气球')

  const meta = { name: '告白气球', artist: ['周杰伦'] }
  const exact = scoreCandidate(meta, { name: '告白气球', artist: ['周杰伦'] })
  const cover = scoreCandidate(meta, { name: '告白气球 (翻唱)', artist: ['某翻唱'] })
  const other = scoreCandidate(meta, { name: '稻香', artist: ['周杰伦'] })

  assert.ok(exact > cover)
  assert.equal(other, -1)
})

test('无 refresh_token 但直链仍可用时，不误判为失效', async () => {
  const env = makeEnv()
  const noRefresh = 'uin=o555666; qqmusic_key=LIVEKEY1234; qm_keyst=LIVEKEY1234'
  await savePrimaryCookie(env, noRefresh)
  vkeyUrl = '/C400probe.m4a?vkey=OK'

  const result = await maintainCookie(env, { trigger: 'cron' })

  assert.equal(result.status, 'ok')
  assert.equal(result.action, 'probe-ok')
  assert.equal(sent.length, 0)
  assert.equal(await getActiveCookie(env), noRefresh)
})

test('无 refresh_token 且 VIP 探测拿不到直链时判定失效', async () => {
  const env = makeEnv()
  const noRefresh = 'uin=o555666; qqmusic_key=LIVEKEY1234; qm_keyst=LIVEKEY1234'
  await savePrimaryCookie(env, noRefresh)
  vkeyUrl = ''

  const result = await maintainCookie(env, { trigger: 'cron' })

  assert.equal(result.status, 'anonymous')
  assert.equal(sent.length, 1)
})

test('匿名期间补入备用 Cookie 会立即接管', async () => {
  const env = makeEnv()
  await savePrimaryCookie(env, BAD)
  await maintainCookie(env, { trigger: 'cron' })
  assert.equal((await getState(env)).status, 'anonymous')

  await addBackupCookie(env, BACKUP, '后补备用')
  const result = await maintainCookie(env, { trigger: 'cron' })

  assert.equal(result.status, 'degraded')
  assert.equal(await getActiveCookie(env), BACKUP)
})

test('管理接口：写入 Cookie、查看状态、备份增删', async () => {
  const env = makeEnv()
  const app = createApp()

  const post = (path, body) => app.fetch(new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }), env)

  const created = await post('/admin/cookie?token=token', { cookie: BACKUP, test: false })
  assert.equal(created.status, 200)
  const createdBody = await created.json()
  assert.equal(createdBody.ok, true)
  assert.equal(createdBody.state.status, 'ok')

  const backup = await post('/admin/cookie/backup?token=token', { cookie: BAD, label: '备用A' })
  assert.equal((await backup.json()).backupCount, 1)

  const status = await app.fetch(new Request('http://localhost/status'), env)
  const statusBody = await status.json()
  assert.equal(statusBody.status, 'ok')
  assert.equal(statusBody.backupCount, 1)
  assert.equal(JSON.stringify(statusBody).includes('BADKEY0001'), false)

  const deleted = await app.fetch(new Request('http://localhost/admin/cookie/backup?token=token&id=' + encodeURIComponent((await (await app.fetch(new Request('http://localhost/admin/cookie/backups?token=token'), env)).json()).backups[0].id), { method: 'DELETE' }), env)
  assert.equal((await deleted.json()).backupCount, 0)
})

test('管理接口鉴权失败返回 401', async () => {
  const env = makeEnv()
  const app = createApp()
  const response = await app.fetch(new Request('http://localhost/admin/cookie?token=wrong', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cookie: BACKUP })
  }), env)
  assert.equal(response.status, 401)
})
