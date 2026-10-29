import { describe, expect, it } from 'bun:test'
import { createUnrestrictedHttpAccess } from 'emdash'
import { createProbeHttp, headerOnlyFetch } from '../src/http'

// IP literals skip the host guard's DNS lookup, so these tests make no network calls.
const PUBLIC = 'http://93.184.215.14/'
const MIB = 1024 * 1024

/** A body that sends `bytes` (in 1 MiB chunks) and then either ends or hangs; records a cancel. */
function body(bytes: number, hang: boolean, onCancel: () => void = () => {}): ReadableStream<Uint8Array> {
  let sent = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent < bytes) {
        const size = Math.min(MIB, bytes - sent)
        sent += size
        controller.enqueue(new Uint8Array(size))
      }
      else if (!hang) {
        controller.close()
      }
      else {
        return new Promise(() => {})
      }
    },
    cancel: onCancel,
  })
}

/** A fake `fetch` that answers every URL with `respond` and records what it was asked for. */
function fakeFetch(respond: (url: string) => Response) {
  const calls: string[] = []
  const impl = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    return respond(url)
  }) as typeof fetch
  return { impl, calls }
}

describe('headerOnlyFetch', () => {
  it('resolves at the headers of a body that never ends, and cancels that body', async () => {
    let cancelled = false
    const { impl } = fakeFetch(() => new Response(body(10, true, () => {
      cancelled = true
    }), { status: 503, statusText: 'Service Unavailable', headers: { 'x-probe': 'yes' } }))
    const response = await headerOnlyFetch(impl)(PUBLIC)
    expect(response.status).toBe(503)
    expect(response.statusText).toBe('Service Unavailable')
    expect(response.headers.get('x-probe')).toBe('yes')
    expect(response.body).toBeNull()
    await Bun.sleep(0)
    expect(cancelled).toBe(true)
  })
})

describe('createProbeHttp', () => {
  it('grades a body over the host\'s 8 MiB cap by its status, where the host\'s own access rejects it', async () => {
    const big = () => new Response(body(9 * MIB, false), { status: 200 })
    const response = await createProbeHttp('statusbeam', fakeFetch(big).impl).fetch(PUBLIC)
    expect(response.status).toBe(200)
    await expect(createUnrestrictedHttpAccess('statusbeam', fakeFetch(big).impl).fetch(PUBLIC)).rejects.toThrow(/exceeds the 8388608 byte limit/)
  })

  it('refuses loopback and cloud-metadata targets before any fetch', async () => {
    const { impl, calls } = fakeFetch(() => new Response(null, { status: 200 }))
    const http = createProbeHttp('statusbeam', impl)
    await expect(http.fetch('http://127.0.0.1/')).rejects.toThrow(/blocked fetch to "127\.0\.0\.1"/)
    await expect(http.fetch('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/blocked fetch to "169\.254\.169\.254"/)
    expect(calls).toEqual([])
  })

  it('refuses a public URL that redirects to the metadata address, without following it', async () => {
    const { impl, calls } = fakeFetch(() => new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/' } }))
    await expect(createProbeHttp('statusbeam', impl).fetch(PUBLIC)).rejects.toThrow(/blocked fetch to "169\.254\.169\.254"/)
    expect(calls).toEqual([PUBLIC])
  })
})
