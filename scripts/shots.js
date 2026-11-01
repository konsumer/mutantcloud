#!/usr/bin/env node
// npm run shots: a picture of each firmware's own screen, from the FM-1 emulator
// (joakimeriksson/fm1-emu, MIT). Boots each firmware's checked package headlessly, saves the
// LCD a few seconds in, and writes public/shots/<id>.png (240x240, scaled up crisply by CSS).
//
//   npm run shots                    shoot firmwares that have no picture at all yet (not even the maker's)
//   npm run shots -- --update        also re-shoot ones whose package changed
//   npm run shots -- --only a,b      just these ids (re-shoots them)
//   npm run shots -- --ms 8000       how long to run each (emulated ms, default 8000)
//   npm run shots -- --jobs 4        how many at once (default: half the CPU cores)
//
// env: FM1_EMU=/path/to/fm1-emu to use your own build (else the latest release is downloaded
// into .cache/), SITE_URL (where the list comes from, default https://mutant.cloud)

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, chmod } from 'node:fs/promises'
import { cpus, tmpdir, platform, arch } from 'node:os'
import { join } from 'node:path'
import { deflateSync, crc32 } from 'node:zlib'
import { ghToken } from './wrangler.js'

const ROOT = new URL('..', import.meta.url).pathname
const OUT = join(ROOT, 'public/shots')
const CACHE = join(ROOT, '.cache')
const INDEX = join(OUT, 'index.json')
const SITE = process.env.SITE_URL || 'https://mutant.cloud'
const UA = { 'user-agent': 'mutant.cloud shots (+https://mutant.cloud)' }

const argv = process.argv.slice(2)
const flag = (n) => argv.includes(n)
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d)
const MS = Number(opt('--ms', 8000))
const JOBS = Number(opt('--jobs', Math.max(1, Math.floor(cpus().length / 2))))
const ONLY = opt('--only', '').split(',').filter(Boolean)
const UPDATE = flag('--update')

const log = (...a) => console.log(...a)

// --- the emulator ---------------------------------------------------------

async function emulator() {
  if (process.env.FM1_EMU) return process.env.FM1_EMU
  const plat = { darwin: 'macos', linux: 'linux' }[platform()]
  const cpu = { arm64: 'arm64', x64: 'x86_64' }[arch()]
  if (!plat || !cpu) throw new Error(`no fm1-emu build for ${platform()}/${arch()}: build it and set FM1_EMU`)
  const token = ghToken()
  const headers = { ...UA, accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) }
  const rel = await (await fetch('https://api.github.com/repos/joakimeriksson/fm1-emu/releases/latest', { headers })).json()
  const asset = rel.assets?.find((a) => a.name.startsWith('fm1-emu-') && a.name.endsWith(`-${plat}-${cpu}.tar.gz`))
  if (!asset) throw new Error(`fm1-emu ${rel.tag_name} has no ${plat}-${cpu} build: build it and set FM1_EMU`)
  const dir = join(CACHE, 'fm1-emu', rel.tag_name)
  const found = existsSync(dir) && (await findFile(dir, 'fm1-emu'))
  if (found) return found
  log(`downloading ${asset.name}…`)
  await mkdir(dir, { recursive: true })
  const tgz = join(dir, asset.name)
  await writeFile(tgz, Buffer.from(await (await fetch(asset.browser_download_url, { headers: UA })).arrayBuffer()))
  await run('tar', ['-xzf', tgz, '-C', dir], { timeout: 60000 })
  const bin = await findFile(dir, 'fm1-emu')
  if (!bin) throw new Error(`no fm1-emu binary in ${asset.name}`)
  await chmod(bin, 0o755)
  return bin
}

async function findFile(dir, name) {
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile() && e.name === name) return join(e.parentPath || e.path, e.name)
  }
  return null
}

function run(cmd, args, { cwd, timeout }) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    p.stderr.on('data', (d) => (err += d))
    p.stdout.on('data', () => {})
    const t = setTimeout(() => p.kill('SIGKILL'), timeout)
    p.on('close', (code) => {
      clearTimeout(t)
      resolve({ code, err })
    })
  })
}

// --- images ---------------------------------------------------------------

// fm1_soc::write_bmp output (and any plain 16/24/32-bit BMP) -> { w, h, rgb }
function readBmp(buf) {
  if (buf.toString('latin1', 0, 2) !== 'BM') throw new Error('not a BMP')
  const off = buf.readUInt32LE(10)
  const w = buf.readInt32LE(18)
  const hRaw = buf.readInt32LE(22)
  const h = Math.abs(hRaw)
  const bpp = buf.readUInt16LE(28)
  const stride = Math.ceil((bpp * w) / 32) * 4
  const rgb = Buffer.alloc(w * h * 3)
  for (let y = 0; y < h; y++) {
    const row = off + (hRaw > 0 ? h - 1 - y : y) * stride
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3
      if (bpp === 24 || bpp === 32) {
        const p = row + x * (bpp / 8)
        rgb[o] = buf[p + 2]
        rgb[o + 1] = buf[p + 1]
        rgb[o + 2] = buf[p]
      } else if (bpp === 16) {
        const v = buf.readUInt16LE(row + x * 2) // RGB565
        rgb[o] = (((v >> 11) & 31) * 255) / 31
        rgb[o + 1] = (((v >> 5) & 63) * 255) / 63
        rgb[o + 2] = ((v & 31) * 255) / 31
      } else {
        throw new Error(`${bpp}-bit BMP`)
      }
    }
  }
  return { w, h, rgb }
}

// how many colours: a blank or nearly blank screen isn't worth showing
function colours({ rgb }) {
  const seen = new Set()
  for (let i = 0; i < rgb.length && seen.size < 64; i += 3) seen.add((rgb[i] << 16) | (rgb[i + 1] << 8) | rgb[i + 2])
  return seen.size
}

function png({ w, h, rgb }) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td) >>> 0)
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // RGB
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

// --- one firmware ---------------------------------------------------------

async function fetchPackage(row) {
  const file = join(CACHE, 'fwsc', `${row.sha256}.fwsc`)
  if (existsSync(file)) return file
  const r = await fetch(row.pkg, { headers: UA })
  if (!r.ok) throw new Error(`download ${r.status}`)
  const buf = Buffer.from(await r.arrayBuffer())
  if (createHash('sha256').update(buf).digest('hex') !== row.sha256) throw new Error('sha256 does not match the list')
  await mkdir(join(CACHE, 'fwsc'), { recursive: true })
  await writeFile(file, buf)
  return file
}

async function shoot(bin, row, ms = MS) {
  const fwsc = await fetchPackage(row)
  const dir = await mkdtemp(join(tmpdir(), 'fm1shot-'))
  try {
    await mkdir(join(dir, 'work'))
    const times = [Math.round(ms * 0.35), Math.round(ms * 0.7), ms]
    const { code, err } = await run(bin, ['--fwsc', fwsc, '--ms', String(ms), '--snap', times.join(','), '--quiet'], { cwd: dir, timeout: 10 * 60 * 1000 })
    // newest screen with something on it (the main screen, not the boot splash), else an earlier one
    const files = [...times.reverse().map((t) => `lcd_${t}.bmp`), 'lcd.bmp']
    for (const f of files) {
      const p = join(dir, 'work', f)
      if (!existsSync(p)) continue
      const img = readBmp(await readFile(p))
      if (colours(img) >= 3) return png(img)
    }
    throw new Error(code ? `emulator exit ${code}: ${err.trim().split('\n').pop()}` : 'blank screen')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// --- main -----------------------------------------------------------------

async function main() {
  const list = await (await fetch(`${SITE}/catalog.json`, { headers: UA })).json()
  // a screenshot is only the fallback picture: listings with the maker's own picture don't need one
  const all = await (await fetch(`${SITE}/firmware.json?device=all&kind=all`, { headers: UA })).json()
  const hasPicture = new Set(all.entries.filter((e) => e.card || e.image).map((e) => e.id))
  // one package per firmware: the main FM-1 build if there is one (the emulator's home board)
  const rank = (r) => (/^FM-1_/.test(r.product) ? 2 : 0) + (r.id === r.entry || r.entry === 'stock' ? 1 : 0)
  const byEntry = new Map()
  for (const row of [...(list.stock ? [{ ...list.stock, entry: 'stock' }] : []), ...list.firmwares]) {
    const cur = byEntry.get(row.entry)
    if (!cur || rank(row) > rank(cur)) byEntry.set(row.entry, row)
  }
  const index = JSON.parse(await readFile(INDEX, 'utf8').catch(() => '{}'))
  // only what's missing: never one that's already here, one the maker's picture covers, or one that failed
  // before (unless --update, which also re-shoots firmware whose package changed)
  let covered = 0
  const todo = [...byEntry.values()].filter((r) => {
    if (ONLY.length) return ONLY.includes(r.entry)
    const had = index[r.entry]
    const have = had && !had.failed && existsSync(join(OUT, `${r.entry}.png`))
    if (have) return UPDATE && had.sha256 !== r.sha256
    if (hasPicture.has(r.entry)) {
      covered++
      return false
    }
    return !had?.failed || UPDATE
  })
  if (covered) log(`(${covered} have the maker's own picture, so no screenshot is needed)`)
  log(`${byEntry.size} firmwares with packages, ${todo.length} to shoot (${JOBS} at a time, ${MS} ms each)`)
  if (!todo.length) return

  const bin = await emulator()
  log(`emulator: ${bin}`)
  await mkdir(OUT, { recursive: true })
  let done = 0
  let ok = 0
  const save = () => writeFile(INDEX, JSON.stringify(index, null, 1) + '\n')
  await Promise.all(
    Array.from({ length: JOBS }, async () => {
      while (todo.length) {
        const row = todo.shift()
        const t0 = Date.now()
        try {
          // a blank screen often just means a slow start: one longer try, in this run only
          const img = await shoot(bin, row).catch((e) => (e.message === 'blank screen' ? shoot(bin, row, MS * 2.5) : Promise.reject(e)))
          await writeFile(join(OUT, `${row.entry}.png`), img)
          index[row.entry] = { sha256: row.sha256, product: row.product, version: row.version, v: createHash('sha1').update(img).digest('hex').slice(0, 8) }
          ok++
          log(`  ✓ ${row.entry} (${row.product}, ${((Date.now() - t0) / 1000).toFixed(0)}s)`)
        } catch (e) {
          index[row.entry] = { sha256: row.sha256, product: row.product, failed: e.message }
          log(`  ✗ ${row.entry}: ${e.message}`)
        }
        if (++done % 10 === 0) await save()
      }
    })
  )
  await save()
  log(`\n${ok} new pictures in public/shots/. Run \`npm run deploy\` to put them on the site.`)
}

export { readBmp, png, colours }

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`✗ ${e.message}`)
    process.exit(1)
  })
}
