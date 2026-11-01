// .fwsc package checks, shared by the worker and scripts/collect.js.
// product() is a port of fm1buddy's pkgHead (src/app/fm1.cpp) / tools/smk37.py product().

const BLOCKS = 20
const BLK = 0x30
const KEEP = 0x2f
const MAX_BLOCKS = 64
export const HEAD_BYTES = MAX_BLOCKS * BLK

// which device a package says it is for: "FM-1_961", "SMK-37 Elite_016", or null if it isn't a package
export function product(raw) {
  if (!raw || raw.length < BLOCKS * BLK) return null
  const marker = (k) => ((k + 1) * BLK <= raw.length ? raw[k * BLK + KEEP] : null)
  const ok = (m, i) => {
    const c = (m - i - 1) & 0xff
    return c >= 0x20 && c < 0x7f
  }
  let n = BLOCKS
  while (n < MAX_BLOCKS) {
    const m = marker(n)
    if (m === null || m === 0x7d || !ok(m, n)) break
    n++
  }
  const ids = n > BLOCKS && marker(n) === 0x7d ? n : BLOCKS
  let out = ''
  for (let i = 0; i < ids; i++) {
    const m = raw[i * BLK + KEEP]
    if (m === 0x7d) continue
    if (!ok(m, i)) return null
    out += String.fromCharCode((m - i - 1) & 0xff)
  }
  return /^[A-Za-z0-9 .+-]+_[0-9A-Za-z]+$/.test(out) ? out : null
}

// the device id (our DEVICES keys) for a product string
export function deviceOf(p) {
  if (!p) return null
  if (/^FM-1_/i.test(p)) return 'fm1'
  if (/^(SMK-37|MKE-P37)/i.test(p)) return 'smk37'
  return null
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

// check one package URL. With a GitHub digest only the head is fetched; otherwise the whole file.
// returns { sha256, size, product } or null if it is not an installable package
export async function inspect(url, { digest, size, headers = {} } = {}) {
  const sha = digest?.startsWith('sha256:') ? digest.slice(7) : null
  if (sha && size) {
    const r = await fetch(url, { headers: { ...headers, range: `bytes=0-${HEAD_BYTES - 1}` }, redirect: 'follow' })
    if (!r.ok) return null
    const p = product(new Uint8Array(await r.arrayBuffer()))
    return p ? { sha256: sha, size, product: p } : null
  }
  const r = await fetch(url, { headers, redirect: 'follow' })
  if (!r.ok) return null
  const len = Number(r.headers.get('content-length') || 0)
  if (len > 16 * 1024 * 1024) return null
  const buf = await r.arrayBuffer()
  if (buf.byteLength > 16 * 1024 * 1024) return null
  const p = product(new Uint8Array(buf, 0, Math.min(buf.byteLength, HEAD_BYTES)))
  if (!p) return null
  return { sha256: hex(await crypto.subtle.digest('SHA-256', buf)), size: buf.byteLength, product: p }
}
