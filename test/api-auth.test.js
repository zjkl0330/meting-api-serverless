import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac, createHash, createCipheriv } from 'node:crypto'

import Meting from '@meting/core'
import { createApp } from '../src/app.js'
import { patchNeteaseEapiEncrypt } from '../src/utils/metingFactory.js'
import { __resetMemoryStore } from '../src/utils/store.js'

// 与 README / src/service/api.js 保持一致的鉴权算法：HMAC-SHA1(TOKEN, server+type+id)
const auth = (server, type, id, token = 'token') =>
  createHmac('sha1', token).update(`${server}${type}${id}`).digest('hex')

const json = (body) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json' }
})

const searchBody = {
  result: {
    songs: [{
      id: 35847388,
      name: 'Hello',
      ar: [{ name: 'Adele' }],
      al: { name: 'Hello', pic_str: '109951168981824640' }
    }]
  }
}

const realFetch = globalThis.fetch

test.beforeEach(() => {
  __resetMemoryStore()
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url
    if (url.includes('cloudsearch')) return json(searchBody)
    if (url.includes('enhance/player/url')) {
      return json({ data: [{ url: 'https://m7.music.126.net/hello.mp3', size: 1000, br: 320 }] })
    }
    throw new Error(`未预期的上游请求: ${url}`)
  }
})

test.after(() => { globalThis.fetch = realFetch })

const env = () => ({ METING_TOKEN: 'token' })

test('netease eapi 补丁密文与 Node AES-128-ECB 参考实现一致', () => {
  const req = {
    url: 'http://music.163.com/api/v3/song/detail/',
    body: { c: '[{"id":123,"v":0}]' }
  }
  const bodyStr = JSON.stringify(req.body)
  const path = req.url.replace(/https?:\/\/[^/]+/, '')
  const sign = createHash('md5').update(`nobody${path}use${bodyStr}md5forencrypt`).digest('hex')
  const payload = `${path}-36cd479b6b5-${bodyStr}-36cd479b6b5-${sign}`

  const cipher = createCipheriv('aes-128-ecb', Buffer.from('e82ckenh8dichen8', 'utf8'), null)
  cipher.setAutoPadding(true)
  const expected = (cipher.update(payload, 'utf8', 'hex') + cipher.final('hex')).toUpperCase()

  const meting = new Meting('netease')
  patchNeteaseEapiEncrypt(meting)
  const out = meting.provider.eapiEncrypt({ ...req })

  assert.equal(out.url, 'http://music.163.com/eapi/v3/song/detail/')
  assert.deepEqual(out.body, { params: expected })
})

test('url 接口：缺失/错误 auth 返回 401，正确 auth 返回 302 直链', async () => {
  const app = createApp()
  const base = 'http://localhost/api?server=netease&type=url&id=35847388'

  assert.equal((await app.fetch(new Request(base), env())).status, 401)
  assert.equal((await app.fetch(new Request(`${base}&auth=deadbeef`), env())).status, 401)

  const ok = await app.fetch(
    new Request(`${base}&auth=${auth('netease', 'url', '35847388')}`),
    env()
  )
  assert.equal(ok.status, 302)
  assert.match(ok.headers.get('location'), /m7\.music\.126\.net/)
})

test('search 响应自带的 auth url 可被 url 接口直接播放', async () => {
  const app = createApp()
  const e = env()

  const searchRes = await app.fetch(
    new Request('http://localhost/api?server=netease&type=search&id=hello'),
    e
  )
  assert.equal(searchRes.status, 200)
  const tracks = await searchRes.json()
  assert.ok(Array.isArray(tracks) && tracks.length > 0)

  const playUrl = new URL(tracks[0].url)
  assert.equal(
    playUrl.searchParams.get('auth'),
    auth('netease', 'url', playUrl.searchParams.get('id'))
  )

  const playRes = await app.fetch(new Request(playUrl.toString()), e)
  assert.equal(playRes.status, 302)
  assert.match(playRes.headers.get('location'), /m7\.music\.126\.net/)
})
