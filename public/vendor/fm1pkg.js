// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
//
// FM-1 (and M-Vave SMK-37) .fwsc packages in the browser: the package identity and the image the
// device reads during an update.

const BLOCKS = 20,
  BLK = 0x30,
  KEEP = 0x2f

// the package identity ("FM-1_904", "SMK-37 Pro_016"): one marker byte after each of the first 20 blocks
export function productOf(fwsc) {
  if (fwsc.length < BLOCKS * BLK) throw new Error('not an FM-1 package (too short)')
  let s = ''
  for (let i = 0; i < BLOCKS; i++) {
    const m = fwsc[i * BLK + KEEP]
    if (m !== 0x7d) s += String.fromCharCode((m - i - 1) & 0xff)
  }
  return s
}

// JieLi ENC stream cipher (in place) and CRC16 (poly 0x1021, init 0), as tools/fm1pkg_make.py
function enc(buf, off, size, key = 0xffff) {
  for (let i = 0; i < size; i++) {
    buf[off + i] ^= key & 0xff
    key = ((key << 1) ^ (key & 0x8000 ? 0x1021 : 0)) & 0xffff
  }
}
function crc16(d, c = 0) {
  for (const b of d) {
    c ^= b << 8
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff
  }
  return c
}

// interleave blocks: 20, then more while the marker is the unused 0x7d (the stock SMK-37 Pro v016 has 36)
function blockCount(fwsc) {
  let n = BLOCKS
  while (n < 64 && (n + 1) * BLK <= fwsc.length && fwsc[n * BLK + KEEP] === 0x7d) n++
  return n
}

function deinterleave(fwsc, blocks) {
  const out = new Uint8Array(fwsc.length - blocks)
  for (let i = 0; i < blocks; i++) out.set(fwsc.subarray(i * BLK, i * BLK + KEEP), i * KEEP)
  out.set(fwsc.subarray(blocks * BLK), blocks * KEEP)
  return out
}

// flash.bin (type 0) and ota.bin (type 100) match their CRCs (the only files whose CRCs stock packages keep right)
function filesOk(img) {
  if (img.length < 0x40) return false
  const rd = (a, o, n) => a.slice(o, o + n).reduce((v, x, i) => v + x * 2 ** (8 * i), 0)
  const h = Uint8Array.from(img.subarray(0, 0x40))
  enc(h, 0, 0x40)
  const count = rd(h, 8, 2)
  if (count < 1 || count > 8 || img.length < 0x40 + 0x50 * count) return false
  for (let i = 0; i < count; i++) {
    const e = Uint8Array.from(img.subarray(0x40 + i * 0x50, 0x90 + i * 0x50))
    enc(e, 0, 0x50)
    const typ = rd(e, 0, 2),
      off = rd(e, 8, 4),
      size = rd(e, 12, 4)
    if (off + size > img.length) return false
    if ((typ === 0 || typ === 100) && crc16(img.subarray(off, off + size)) !== rd(e, 4, 2)) return false
  }
  return true
}

// the image the device addresses during an update: the .fwsc without the marker bytes (20 blocks, or the detected
// count when the files' CRCs agree: a 20-block package can have 0x7d after block 20 by chance)
export function logicalImage(fwsc) {
  const n = blockCount(fwsc)
  if (n !== BLOCKS) {
    const img = deinterleave(fwsc, n)
    if (filesOk(img) || !filesOk(deinterleave(fwsc, BLOCKS))) return img
  }
  return deinterleave(fwsc, BLOCKS)
}
