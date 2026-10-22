/**
 * Spike fixture Worker for the ADR-0004 probe-semantics spike.
 *
 * Every endpoint is public and deterministic so the probe plugin can grade it
 * in each EmDash execution mode. Deployed as `statusbeam-emdash-spike-fixtures`.
 * Each request is logged with its path, so `wrangler tail` counts the probes
 * that reached the fixture even when the probing invocation is killed.
 */

const MIB = 1024 * 1024
const CHUNK = 64 * 1024

function intParam(url: URL, name: string, fallback: number, max: number): number {
  const raw = Number(url.searchParams.get(name))
  if (!Number.isFinite(raw) || raw <= 0) {
    return fallback
  }
  return Math.min(Math.floor(raw), max)
}

/** A body of `bytes` bytes, written in `chunk`-sized pieces with `delayMs` spread across them. */
function streamBody(bytes: number, delayMs: number, ctx: ExecutionContext, chunk = CHUNK): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()
  const chunks = Math.max(1, Math.ceil(bytes / chunk))
  const pause = delayMs / chunks
  const block = new Uint8Array(chunk).fill(97)
  ctx.waitUntil((async () => {
    try {
      let left = bytes
      for (let i = 0; i < chunks; i++) {
        const size = Math.min(chunk, left)
        await writer.write(size === chunk ? block : block.subarray(0, size))
        left -= size
        if (pause > 0) {
          await new Promise(resolve => setTimeout(resolve, pause))
        }
      }
      await writer.close()
    }
    catch {
      // The client went away; nothing left to do.
    }
  })())
  return readable
}

async function route(req: Request, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname

  // A body larger than (or close to) the 8 MiB sandbox limit, sent fast.
  // `?mib=9` (default) is over the limit; `?mib=7` is just under it.
  if (path === '/big') {
    const bytes = intParam(url, 'mib', 9, 32) * MIB
    return new Response(streamBody(bytes, 0, ctx), {
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes) },
    })
  }

  // Headers immediately, a small body that finishes after `ms` (default 3 s).
  if (path === '/slow-body') {
    const ms = intParam(url, 'ms', 3000, 120_000)
    const kb = intParam(url, 'kb', 64, 4096)
    return new Response(streamBody(kb * 1024, ms, ctx), {
      headers: { 'content-type': 'text/plain' },
    })
  }

  // Headers only after `ms` (default 3 s): the control for slow-body.
  if (path === '/slow-headers') {
    const ms = intParam(url, 'ms', 3000, 120_000)
    await new Promise(resolve => setTimeout(resolve, ms))
    return new Response('ok', { headers: { 'content-type': 'text/plain' } })
  }

  // A streaming body that keeps trickling: one 1 KiB chunk per second for
  // `s` seconds (default 120 s, far past the 30 s wall-time limit).
  if (path === '/stream') {
    const seconds = intParam(url, 's', 120, 600)
    return new Response(streamBody(seconds * 1024, seconds * 1000, ctx, 1024), {
      headers: { 'content-type': 'text/event-stream' },
    })
  }

  // A cheap endpoint for the capacity test.
  if (path.startsWith('/ok')) {
    return new Response('ok', { headers: { 'content-type': 'text/plain' } })
  }

  // Notification-style POST target (Slack / generic webhook stand-in).
  if (path === '/notify') {
    if (req.method !== 'POST') {
      return new Response('method not allowed', { status: 405 })
    }
    await req.text()
    return new Response(null, { status: 204 })
  }

  // An arbitrary status code, for "target error" grading. `Response` accepts
  // 200-599 only, and a null-body status must not carry a body.
  const status = /^\/status\/(\d{3})$/.exec(path)
  if (status) {
    const code = Number(status[1])
    if (code < 200 || code > 599) {
      return new Response(`status ${code} cannot be served; use 200-599`, { status: 400 })
    }
    return new Response([204, 205, 304].includes(code) ? null : `status ${code}`, { status: code })
  }

  return new Response('not found', { status: 404 })
}

export default {
  async fetch(req, _env, ctx) {
    const url = new URL(req.url)
    console.warn(JSON.stringify({ fixture: url.pathname, query: url.search, method: req.method }))
    return route(req, ctx)
  },
} satisfies ExportedHandler
