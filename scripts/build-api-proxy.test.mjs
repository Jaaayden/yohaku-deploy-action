import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createBuildProxy } from './build-api-proxy.mjs'

async function setup(t, handler, options = {}) {
  const upstream = http.createServer(handler)
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const proxy = await createBuildProxy({ upstream: `http://127.0.0.1:${upstream.address().port}/api/v3`, interval: 1, retryBase: 1, ...options })
  t.after(async () => {
    await proxy.close()
    await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections() })
  })
  return proxy
}
const json = (res, data) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)) }

test('concurrent aggregate requests coalesce; languages remain distinct', async t => {
  let count = 0
  const p = await setup(t, (req, res) => { count++; setTimeout(() => json(res, { path: req.url }), 15) })
  const url = p.url + '/aggregate?theme=yohaku%7Cshiro&lang=zh'
  const results = await Promise.all(Array.from({ length: 50 }, () => fetch(url).then(r => r.json())))
  assert.equal(count, 1)
  assert.ok(results.every(r => r.path.endsWith('lang=zh')))
  await fetch(url)
  await fetch(p.url + '/aggregate?theme=yohaku%7Cshiro&lang=en')
  assert.equal(count, 2)
})
test('other GETs are serialized and paced but never cached', async t => {
  const starts = []
  const p = await setup(t, (req, res) => { starts.push(Date.now()); json(res, {}) }, { interval: 30 })
  await Promise.all(Array.from({ length: 3 }, () => fetch(p.url + '/posts')))
  assert.equal(starts.length, 3)
  assert.ok(starts[2] - starts[0] >= 50)
})
test('429 honors Retry-After and successful response is cached', async t => {
  const starts = []
  const p = await setup(t, (req, res) => {
    starts.push(Date.now())
    if (starts.length === 1) { res.writeHead(429, { 'retry-after': '0.05' }); res.end() }
    else json(res, {})
  })
  const url = p.url + '/aggregate?lang=zh'
  assert.equal((await fetch(url)).status, 200)
  await fetch(url)
  assert.equal(starts.length, 2)
  assert.ok(starts[1] - starts[0] >= 45)
})
test('retry budget is bounded and failure is not cached', async t => {
  let count = 0
  const p = await setup(t, (req, res) => { count++; res.writeHead(429); res.end() }, { retries: 1 })
  const url = p.url + '/aggregate'
  assert.equal((await fetch(url)).status, 429)
  assert.equal((await fetch(url)).status, 429)
  assert.equal(count, 4)
})
test('cache expiry and protected/non-read requests', async t => {
  let count = 0
  const p = await setup(t, (req, res) => { count++; json(res, {}) }, { ttl: 10 })
  await fetch(p.url + '/aggregate')
  await new Promise(r => setTimeout(r, 20))
  await fetch(p.url + '/aggregate')
  assert.equal(count, 2)
  assert.equal((await fetch(p.url + '/aggregate', { method: 'POST' })).status, 405)
  assert.equal((await fetch(p.url + '/aggregate', { headers: { authorization: 'test' } })).status, 403)
  assert.equal((await fetch(p.url + '/../outside')).status, 404)
  assert.equal(count, 2)
})
test('wrapper isolates child API_URL, preserves public URL and exit code', async () => {
  const script = new URL('./build-api-proxy.mjs', import.meta.url)
  const child = spawn(process.execPath, [fileURLToPath(script), process.execPath, '-e', `
    if (!process.env.API_URL.startsWith('http://127.0.0.1:')) process.exit(2)
    if (process.env.NEXT_PUBLIC_API_URL !== 'https://example.com/api/v3') process.exit(3)
    process.exit(7)
  `], { env: { ...process.env, NEXT_PUBLIC_API_URL: 'https://example.com/api/v3' }, stdio: 'ignore' })
  const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject) })
  assert.equal(code, 7)
})
