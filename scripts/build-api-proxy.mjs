import http from 'node:http'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

// One queue shared by every Next.js build worker. Only public aggregate GETs
// are cached; nothing is persisted between builds or shipped with the release.
export async function createBuildProxy({ upstream, interval = 250, retries = 3,
  retryBase = 1000, maxRetryWait = 60000, timeout = 7000, ttl = 600000 } = {}) {
  const base = new URL(upstream)
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('Expected a credential-free API base URL')
  }
  const prefix = base.pathname.replace(/\/$/, '')
  const cache = new Map()
  const pending = new Map()
  let queue = Promise.resolve()
  let nextRequest = 0
  const stats = { upstream: 0, hits: 0, coalesced: 0, retries: 0 }
  function schedule(fn) {
    const job = queue.then(fn)
    queue = job.catch(() => {})
    return job
  }
  async function request(target) {
    for (let attempt = 0; ; attempt++) {
      await sleep(Math.max(0, nextRequest - Date.now()))
      nextRequest = Date.now() + interval
      stats.upstream++
      const response = await fetch(target, {
        redirect: 'error', signal: AbortSignal.timeout(timeout),
        headers: { accept: 'application/json' },
      })
      const body = Buffer.from(await response.arrayBuffer())
      const result = { status: response.status, body,
        type: response.headers.get('content-type') || 'application/octet-stream' }
      if (![429, 502, 503, 504].includes(response.status) || attempt >= retries) return result
      const header = response.headers.get('retry-after')
      const delay = header === null ? NaN : /^\d+(\.\d+)?$/.test(header)
        ? Number(header) * 1000 : Date.parse(header) - Date.now()
      const wait = Number.isFinite(delay) ? Math.max(0, delay) : retryBase * 2 ** attempt
      // Fail instead of violating a longer server-requested cooldown.
      if (wait > maxRetryWait) return result
      stats.retries++
      nextRequest = Math.max(nextRequest, Date.now() + wait)
    }
  }
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET') { res.writeHead(405).end(); return }
    const incoming = new URL(req.url, 'http://localhost')
    if (!incoming.pathname.startsWith(`${prefix}/`)) { res.writeHead(404).end(); return }
    // Never forward browser cookies, authorization or user-controlled origins.
    if (req.headers.authorization || req.headers.cookie) { res.writeHead(403).end(); return }
    const target = new URL(base.origin)
    target.pathname = incoming.pathname
    target.search = incoming.search
    const key = target.href
    const cacheable = incoming.pathname === `${prefix}/aggregate`
      && [...incoming.searchParams.keys()].every(k => ['theme', 'lang'].includes(k))
    try {
      let result
      const cached = cache.get(key)
      if (cacheable && cached && cached.expires > Date.now()) {
        stats.hits++; result = cached.value
      } else if (cacheable && pending.has(key)) {
        stats.coalesced++; result = await pending.get(key)
      } else {
        const job = schedule(() => request(target))
        if (cacheable) pending.set(key, job)
        try {
          result = await job
          if (cacheable && result.status === 200 && result.type.includes('application/json')) {
            // Do not cache an HTML error or a malformed successful response.
            JSON.parse(result.body.toString())
            cache.set(key, { value: result, expires: Date.now() + ttl })
          }
        } finally { if (cacheable) pending.delete(key) }
      }
      res.writeHead(result.status, { 'content-type': result.type, 'cache-control': 'no-store' })
      res.end(result.body)
    } catch {
      // Do not print request URLs, credentials, response bodies or fetch errors.
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end('{"message":"Build API upstream request failed"}')
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return { url: `http://127.0.0.1:${server.address().port}${prefix}`, stats,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }) }
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (!command) throw new Error('Missing build command')
  const proxy = await createBuildProxy({ upstream: process.env.NEXT_PUBLIC_API_URL })
  console.info('Build API proxy ready (loopback only)')
  // API_URL is runtime-read by Yohaku and is scoped to this child process.
  // NEXT_PUBLIC_API_URL remains the real public endpoint.
  const child = spawn(command, args, { stdio: 'inherit', env: { ...process.env, API_URL: proxy.url } })
  const terminate = () => child.kill('SIGTERM')
  const interrupt = () => child.kill('SIGINT')
  process.on('SIGTERM', terminate)
  process.on('SIGINT', interrupt)
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code) => resolve(code ?? 1))
    })
  } finally {
    process.off('SIGTERM', terminate)
    process.off('SIGINT', interrupt)
    await proxy.close()
    console.info('Build API proxy stats:', JSON.stringify(proxy.stats))
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Build API proxy failed'); process.exitCode = 1 })
}
