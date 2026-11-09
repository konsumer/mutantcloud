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

// --- the flash chip -------------------------------------------------------
// Newer FM-1s (autumn 2026) have a UC25HQ80 flash (JEDEC ID 0xB36014), the first ones a Puya P25Q80 (0x856014).
// Firmware that only knows the old one keeps saves in RAM on a newer FM-1, and updates from it can fail.
// The app inside the package says which it knows: the IDs it checks for are in its code.
//   'new': knows the newer chip   'old': only the first one   'any': checks for neither   null: can't tell
// (Agrees with The Firmware Hub's "chip" on every FM-1 package it lists.)

// JieLi's stream cipher (CRC16-CCITT steps), restarted with `key` every `every` bytes
function unjl(d, key, every) {
  for (let i = 0; i < d.length; i += every) {
    let k = key(i)
    const end = Math.min(i + every, d.length)
    for (let j = i; j < end; j++) {
      d[j] ^= k & 0xff
      k = ((k << 1) ^ (k & 0x8000 ? 0x1021 : 0)) & 0xffff
    }
  }
  return d
}
const le = (a, o, n) => a.slice(o, o + n).reduce((v, x, i) => v + x * 2 ** (8 * i), 0)

// the image without the marker byte that ends each of the first `blocks` blocks
function image(raw, blocks) {
  const out = new Uint8Array(raw.length - blocks)
  for (let i = 0; i < blocks; i++) out.set(raw.subarray(i * BLK, i * BLK + KEEP), i * KEEP)
  out.set(raw.subarray(blocks * BLK), blocks * KEEP)
  return out
}

// flash.bin's place in the image (its file table entry is type 0), if the table makes sense
function flashBin(img) {
  if (img.length < 0x40) return null
  const head = unjl(img.slice(0, 0x40), () => 0xffff, 0x40)
  const count = le(head, 8, 2)
  if (count < 1 || count > 8 || img.length < 0x40 + 0x50 * count) return null
  for (let i = 0; i < count; i++) {
    const e = unjl(img.slice(0x40 + i * 0x50, 0x90 + i * 0x50), () => 0xffff, 0x50)
    const off = le(e, 8, 4)
    const size = le(e, 12, 4)
    if (le(e, 0, 2) === 0) return off + size <= img.length && size > APP + 0x200 ? { off, size } : null
  }
  return null
}

const APP = 0x4000 // where the app starts in flash.bin
const APP_KEY = 0x980f // the FM-1's flash key: the app is stored encrypted with it

export function chip(raw) {
  if (!raw || raw.length < MAX_BLOCKS * BLK) return null
  // 20 blocks, or more when they're padded with the unused marker 0x7d (whichever has a file table)
  let n = BLOCKS
  while (n < MAX_BLOCKS && raw[n * BLK + KEEP] === 0x7d) n++
  let img = image(raw, n)
  let f = flashBin(img)
  if (!f && n !== BLOCKS) f = flashBin((img = image(raw, BLOCKS)))
  if (!f) return null
  const app = unjl(img.slice(f.off + APP, f.off + f.size), (i) => APP_KEY ^ (i >> 2), 32)
  // the app must decrypt to its own header ("app_area_head"), or this isn't an FM-1 app we can read
  if (String.fromCharCode(...app.subarray(16, 29)) !== 'app_area_head') return null
  let old = false
  for (let i = app.indexOf(0x14); i >= 0 && i + 3 < app.length; i = app.indexOf(0x14, i + 1)) {
    if (app[i + 1] !== 0x60 || app[i + 3] !== 0) continue
    if (app[i + 2] === 0xb3) return 'new'
    if (app[i + 2] === 0x85) old = true
  }
  return old ? 'old' : 'any'
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

// check one package URL: the whole file is fetched (the flash chip check reads the app inside it).
// returns { sha256, size, product, chip? (FM-1: new, old, any or unknown) }, or null if it is not an installable package. Throws if it couldn't be
// downloaded (worth trying again later, unlike a file that isn't a package). A GitHub digest saves hashing it.
export async function inspect(url, { digest, headers = {} } = {}) {
  const r = await fetch(url, { headers, redirect: 'follow' })
  if (!r.ok) throw new Error(`download failed (${r.status})`)
  const len = Number(r.headers.get('content-length') || 0)
  if (len > 16 * 1024 * 1024) return null
  const buf = await r.arrayBuffer()
  if (buf.byteLength > 16 * 1024 * 1024) return null
  return check(buf, digest?.startsWith('sha256:') ? digest.slice(7) : null)
}

// the same checks on a file already downloaded
export async function check(buf, sha) {
  const raw = new Uint8Array(buf)
  const p = product(raw.subarray(0, Math.min(raw.length, HEAD_BYTES)))
  if (!p) return null
  // (an FM-1 package whose app can't be read is 'unknown', so it isn't looked at again)
  const c = deviceOf(p) === 'fm1' ? chip(raw) || 'unknown' : null
  return { sha256: sha || hex(await crypto.subtle.digest('SHA-256', buf)), size: raw.length, product: p, ...(c ? { chip: c } : {}) }
}

// a checked FM-1 package from before the chip check
export const needsChip = (a) => !!a?.sha256 && deviceOf(a.product) === 'fm1' && !a.chip
