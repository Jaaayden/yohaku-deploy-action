import assert from 'node:assert/strict'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { createBuildProxy } from './build-api-proxy.mjs'

// Start the real release with a NEW runtime API endpoint. A request for a
// nonexistent dynamic post proves the endpoint isn't frozen at build time.
const api = await createBuildProxy({ upstream: process.env.NEXT_PUBLIC_API_URL })
const child = spawn(process.execPath, ['server.js'], {
  cwd: path.resolve('apps/web/.next/standalone/apps/web'),
  env: { ...process.env, NODE_ENV: 'production', HOSTNAME: '127.0.0.1', PORT: '19393', API_URL: api.url },
  stdio: ['ignore', 'pipe', 'pipe'],
})
const errors = []
child.stderr.on('data', chunk => {
  for (const line of chunk.toString().split('\n')) {
    if (/Error|Cannot find|ENOENT/.test(line)) {
      errors.push(line.replace(/https?:\/\/[^\s'"]+/g, '<url>').slice(0, 300))
      if (errors.length > 10) errors.shift()
    }
  }
})
child.stdout.resume()
let exited = false
let spawnError
const exit = new Promise(resolve => {
  child.once('exit', () => { exited = true; resolve() })
  child.once('error', error => { spawnError = error; exited = true; resolve() })
})
try {
  let ready = false
  for (let i = 0; i < 60; i++) {
    assert.ok(!exited && !spawnError, 'Standalone exited before becoming ready')
    ready = await new Promise(resolve => {
      const socket = net.connect(19393, '127.0.0.1')
      socket.setTimeout(500)
      socket.once('connect', () => { socket.destroy(); resolve(true) })
      socket.once('error', () => { socket.destroy(); resolve(false) })
      socket.once('timeout', () => { socket.destroy(); resolve(false) })
    })
    if (ready) break
    await sleep(500)
  }
  assert.ok(ready, 'Standalone did not become ready')
  for (const locale of ['zh', 'en', 'ja', 'ko', 'zh-TW']) {
    const res = await fetch(`http://127.0.0.1:19393/${locale}/friends`, { signal: AbortSignal.timeout(15000) })
    assert.equal(res.status, 200, `${locale} friends page failed (HTTP ${res.status})`)
    const html = await res.text()
    assert.ok(!html.includes('RATE_LIMITED') && !html.includes('Build API upstream request failed'))
  }
  const before = api.stats.upstream
  const response = await fetch('http://127.0.0.1:19393/zh/posts/__build_smoke__/missing', { signal: AbortSignal.timeout(30000) })
  await response.arrayBuffer()
  assert.ok([200, 404].includes(response.status), 'Dynamic missing-post route returned a server error')
  assert.ok(api.stats.upstream > before, 'Dynamic route did not use the new runtime API endpoint')
  console.info('Standalone smoke passed: five locales and runtime API endpoint override')
} finally {
  if (errors.length) console.error('Standalone diagnostics:', errors.join('\n'))
  child.kill('SIGTERM')
  await Promise.race([exit, sleep(5000)])
  if (!exited) { child.kill('SIGKILL'); await exit }
  await api.close()
}
