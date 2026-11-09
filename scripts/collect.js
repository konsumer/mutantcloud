#!/usr/bin/env node
// Collects FM1 / SMK-37 firmwares + tools from the other hubs, GitHub and Reddit, merges them,
// and writes data/auto.json + data/auto.sql (an upsert of the "auto" column only, so
// anything people edited by hand is never touched).
//
// Every .fwsc in the latest release is checked like fm1buddy does (sha256, size, and the device it says it's for),
// so /catalog.json can list it. Results are cached by URL (data/pkgcache.json, the live catalog, FMDB's checks).
//
// env: GITHUB_TOKEN (optional, else `gh auth token`; enables the GitHub refresh), SITE_URL (to keep ids stable)

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { slugify, parseRepo, repoKey, cleanUrl, baseOfRepo, BASE_INFO, RESERVED } from '../src/entry.js'
import { inspect, deviceOf, needsChip } from '../src/pkg.js'
import { ghToken, wrangler, parseJson, DB_NAME } from './wrangler.js'

// --full: re-read everything (every repo on GitHub, every listing). Default: only listings that aren't in the
// database yet. New versions of listed firmware come from the worker's own watcher (and makers' CI), not from here.
const FULL = process.argv.includes('--full')

const SITE = process.env.SITE_URL || 'https://mutant.cloud'
const TOKEN = ghToken()
const OUT = new URL('../data/', import.meta.url)
const UA = { 'user-agent': 'mutant.cloud collector (+https://mutant.cloud)' }

const log = (...a) => console.error(...a)

async function get(url, type = 'json') {
  try {
    const r = await fetch(url, { headers: UA })
    if (!r.ok) throw new Error(`${r.status}`)
    return type === 'json' ? await r.json() : await r.text()
  } catch (e) {
    log(`! could not fetch ${url}: ${e.message}`)
    return null
  }
}

const day = (s) => (s ? String(s).slice(0, 10) : null)
const maxDay = (...a) => a.filter(Boolean).map(day).sort().pop() || null
const minDay = (...a) => a.filter(Boolean).map(day).sort()[0] || null
const decode = (s) =>
  String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

// first sentence or two, for long blurbs
const brief = (s, max = 320) => {
  const t = decode(s)
  if (t.length <= max) return t
  const cut = t.slice(0, max)
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '))
  return end > 80 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '') + '…'
}

const FIRMWARE_FILE = /\.(fwsc|syx|bin|hex|uf2|zip)$/i
const SOURCE_FILE = /(source|src)[^/]*\.(zip|tar\.gz)$|\.tar\.gz$/i
const pickAssets = (assets = []) =>
  assets
    .filter((a) => FIRMWARE_FILE.test(a.name) && !SOURCE_FILE.test(a.name))
    .sort((a, b) => /\.fwsc$/i.test(b.name) - /\.fwsc$/i.test(a.name))
    .slice(0, 12)
    .map((a) => ({ name: a.name, url: a.url, size: a.size || undefined, _digest: a.digest || undefined }))

// package checks by URL: { sha256, size, product } or false (not a package)
const PKG = new Map()
// sha256 of every package listed on the site: a found repo whose packages are all among them is a copy
const LISTED_SHA = new Set()
// the device ids each listed repo's packages use: a fork under its parent's name that keeps them is a build of it
const LISTED_PRODUCTS = new Map()
const addProduct = (repo, product) => {
  if (!repo || !product) return
  const k = repoKey(repo)
  if (!LISTED_PRODUCTS.has(k)) LISTED_PRODUCTS.set(k, new Set())
  LISTED_PRODUCTS.get(k).add(product)
}
// sha256 + size others already checked (FMDB): used like a GitHub digest, so only the header is fetched.
// (FMDB's own "identity" is not the product id, so the product always comes from the file.)
const KNOWN_SHA = new Map()
const seedPkg = (url, c) => {
  if (url && c?.sha256 && c?.product && c?.size && !PKG.has(url)) PKG.set(url, { sha256: c.sha256, size: c.size, product: c.product, ...(c.chip ? { chip: c.chip } : {}) })
}

// --- thefirmwarehub.com ---------------------------------------------------

const HUB_KIND = { drums: 'drums', groove: 'groovebox', synth: 'synth', chords: 'chords', tracker: 'tracker' }

async function fromHub() {
  const d = await get('https://thefirmwarehub.com/catalog.json')
  if (!d) return []
  const out = []
  const smkRepos = new Set(Object.keys(d.smk37?.stars || {}).map((r) => r.toLowerCase()))
  for (const f of d.firmwares || []) {
    const kinds = [].concat(f.kind || [])
    const tags = kinds.map((k) => HUB_KIND[k]).filter(Boolean)
    if (f.ambient) tags.push('generative')
    if (f.hid?.keyboard || f.hid?.mouse) tags.push('midi')
    const links = []
    if (f.install) links.push({ label: 'Install', url: f.install })
    if (f.play) links.push({ label: 'Try in browser', url: f.play })
    if (f.editor) links.push({ label: 'Editor', url: f.editor })
    const cheat = f.fmhub?.data?.cheat || f.cheat
    if (cheat) links.push({ label: 'Cheat sheet', url: cheat })
    const devices = ['fm1']
    if (f.repo && smkRepos.has(f.repo.toLowerCase())) devices.push('smk37')
    out.push({
      src: 'firmwarehub',
      srcId: f.id,
      kind: 'firmware',
      name: f.name,
      author: f.author,
      repo: parseRepo(f.repo),
      description: f.fmhub?.data?.what || f.what,
      tags,
      base: f.base?.[0] || (f.dinghy ? 'dinghy' : null),
      devices,
      license: f.lic,
      homepage: f.site,
      links,
      release: f.version ? { version: f.version, date: day(f.date), url: f.release || null } : null,
      hid: f.hid?.keyboard || f.hid?.mouse ? { keyboard: !!f.hid.keyboard, mouse: !!f.hid.mouse } : undefined,
      // the maker's own card picture (their fmhub.json "image", a path in their repo or a URL)
      card: cardUrl(f.repo, f.fmhub?.data?.image),
      hubPkg: f.sha256 && f.pkg ? { file: f.pkg.split('/').pop(), sha256: f.sha256, size: f.size, product: f.product } : undefined,
      beta: !!f.beta,
      added: day(f.added),
      updated: day(f.date)
    })
  }
  // SMK-37 builds that are not in the FM1 list
  const listed = new Set(out.map((e) => repoKey(e.repo)))
  for (const repo of Object.keys(d.smk37?.stars || {})) {
    if (listed.has(repo.toLowerCase())) continue
    out.push({ src: 'firmwarehub', kind: 'firmware', name: repo.split('/')[1], repo, devices: ['smk37'], links: [] })
  }
  out.push(stock(d.stock))
  return out
}

function cardUrl(repo, image) {
  if (!image) return undefined
  if (/^https:\/\//.test(image)) return image
  if (!repo) return undefined
  return `https://raw.githubusercontent.com/${repo}/HEAD/${image
    .replace(/^\.?\//, '')
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`
}

// M-VAVE's own firmware, to go back to: the FM-1's from M-VAVE's repo, the SMK-37's from M-VAVE's file store
const SMK_STOCK = 'https://yms-file-store.oss-cn-hongkong.aliyuncs.com/software/firmware/'
function stock(hubStock) {
  const fm1 = hubStock?.source?.replace(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\//, 'https://raw.githubusercontent.com/$1/')
  const files = [fm1 && { name: fm1.split('/').pop(), url: fm1 }, { name: 'SMK-37 Pro_016.fwsc', url: SMK_STOCK + 'SMK-37Pro/SMK-37%20Pro_016.fwsc' }, { name: 'SMK-37 Elite_016.fwsc', url: SMK_STOCK + 'SMK-37Elite/SMK-37%20Elite_016.fwsc' }, { name: 'MKE-P37_016.fwsc', url: SMK_STOCK + 'MKE-P37/MKE-P37_016.fwsc' }].filter(Boolean)
  return {
    src: 'firmwarehub',
    srcId: 'stock',
    loose: 'stock',
    kind: 'firmware',
    name: 'M-VAVE stock',
    author: 'M-VAVE',
    description: 'The firmware the device came with, from M-VAVE: put it back to how it was.',
    devices: ['fm1', 'smk37'],
    license: 'Apache-2.0',
    homepage: 'https://www.m-vave.com/',
    stock: true,
    links: [],
    release: { version: 'stock', assets: files }
  }
}

// --- FMDB (stanleygurvich) ------------------------------------------------

const FMDB_TYPE = { groovebox: 'groovebox', synth: 'synth', generative: 'generative', experimental: 'experimental', theory: 'chords', sampler: 'sampler' }
const FMDB_TOOL = { editor: 'editor', installer: 'installer', emulator: 'emulator', library: 'librarian', app: 'app', recovery: 'recovery', guide: 'guide', plugin: 'plugin', presets: 'presets', hardware: 'hardware' }
const FMDB_BASE = { felucca: 'felucca', sloop: 'sloop', fomni: 'fomni', indep: 'original' }

async function fromFmdb() {
  const d = await get('https://stanleygurvich.github.io/FMDB_FM1_FirmwareDatabase/feed.json')
  if (!d) return []
  const out = []
  for (const f of d.firmwares || []) {
    if (f.unavailable || f.missing || f.install === 'gone') continue
    const tool = f.fam === 'tool'
    const tags = tool ? [FMDB_TOOL[f.type]].filter(Boolean) : (f.types || []).map((t) => FMDB_TYPE[t]).filter(Boolean)
    if (f.fam === 'games') tags.push('game')
    const devices = f.board === 'smk37' ? ['smk37'] : f.board === 'both' ? ['fm1', 'smk37'] : ['fm1']
    const links = [...(f.links || []).map(([label, url]) => ({ label, url })), ...(f.tools || []).map((t) => ({ label: t.label, url: t.url }))]
    const image = f.image && !/stanleygurvich\.github\.io/.test(f.image) ? f.image : null
    const r = f.release
    for (const a of [...(r?.assets || []), ...(f.pageFiles || [])]) {
      if (a.check?.ok && a.check.package && a.check.sha256 && a.check.bytes) KNOWN_SHA.set(a.url, { digest: `sha256:${a.check.sha256}`, size: a.check.bytes })
    }
    out.push({
      src: 'fmdb',
      kind: tool ? 'tool' : 'firmware',
      name: f.name,
      author: f.by,
      repo: parseRepo(f.repo),
      description: f.about,
      tags,
      base: tool ? null : FMDB_BASE[f.fam] || null,
      devices,
      license: f.lic && f.lic !== '?' ? f.lic : null,
      homepage: f.home,
      image,
      links,
      release: r ? { version: r.tag || r.name, date: day(r.date), url: r.url, assets: pickAssets(r.assets) } : null,
      history: (f.siteReleases || []).map((x) => ({
        version: x.version,
        date: day(x.date),
        url: x.url,
        prerelease: !!x.beta,
        assets: x.file ? [{ name: x.file.split('/').pop(), url: x.file }] : []
      })),
      pageFiles: (f.pageFiles || []).filter((a) => /\.fwsc$/i.test(a.name)).map((a) => ({ name: a.name, url: a.url })),
      beta: !!f.experimental,
      added: day(f.created || f.seen),
      updated: day(f.commit?.date)
    })
  }
  return out
}

// --- fm1-editor.com/firmware ---------------------------------------------

const ED_CAT = { synths: 'synth', grooveboxes: 'groovebox', generative: 'generative', games: 'game', samplers: 'sampler', chords: 'chords', tools: 'utility' }
const ED_LINK = [
  [/^source|^repository/i, null],
  [/^install/i, 'Install'],
  [/^(try|play) it/i, 'Try in browser'],
  [/^release/i, 'Release'],
  [/^download/i, 'Download'],
  [/manual|guide|quick start/i, 'Manual'],
  [/editor/i, 'Editor'],
  [/^website/i, 'Website'],
  [/cheat/i, 'Cheat sheet'],
  [/firmware hub/i, null]
]

async function fromFm1Editor() {
  const h = await get('https://fm1-editor.com/firmware/', 'text')
  if (!h) return []
  const out = []
  const starts = [...h.matchAll(/<article\s+class="firmware-entry[^"]*"/g)].map((m) => m.index)
  starts.push(h.length)
  for (let i = 0; i < starts.length - 1; i++) {
    const s = h.slice(starts[i], starts[i + 1])
    const attr = (n) => s.match(new RegExp(`${n}="([^"]*)"`))?.[1]
    const id = attr('id')
    const name = decode(s.match(/class="firmware-title"[^>]*>([\s\S]*?)<\/h2>/)?.[1])
    if (!id || !name) continue
    const author = decode(s.match(/class="synthwave-kicker"[^>]*>([\s\S]*?)<\/p>/)?.[1])
    const blurb = s.match(/class="firmware-blurb"[^>]*>([\s\S]*?)<\/p>/)?.[1]
    const status = decode(s.match(/class="firmware-status"[^>]*>\s*<span>([\s\S]*?)<\/span>/)?.[1])
    const img = s.match(/<img[^>]+src="([^"]+)"/)?.[1]
    let repo = null
    let homepage = null
    const links = []
    // (the main link, and the rest in its "more links" menu)
    for (const m of s.matchAll(/<a[^>]*class="[^"]*firmware-(?:menu-)?link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a\s*>/g)) {
      const url = decode(m[1])
      const label = decode(m[2]).replace(/\s*↗$/, '')
      const r = /github\.com\//.test(url) ? parseRepo(url) : null
      if (r && !repo && /^(source|repository)/i.test(label)) {
        repo = r
        continue
      }
      const rule = ED_LINK.find(([re]) => re.test(label))
      if (rule && rule[1] === null) continue
      if (/^website/i.test(label) && !homepage) homepage = url
      links.push({ label: rule ? rule[1] : label, url })
    }
    // a.href in this markup sometimes comes before class, catch those too
    if (!repo) {
      const m = s.match(/href="(https:\/\/github\.com\/[^"]+)"[^>]*>\s*(Source|Repository)/)
      if (m) repo = parseRepo(m[1])
    }
    const tags = (attr('data-categories') || '')
      .split(/\s+/)
      .map((c) => ED_CAT[c])
      .filter(Boolean)
    const smk = /SMK-?37/i.test(name + ' ' + decode(blurb))
    const version = status.match(/^Latest\s+(.+)$/i)?.[1]
    out.push({
      src: 'fm1-editor',
      srcId: id,
      loose: id === 'stock' ? 'stock' : undefined,
      kind: 'firmware',
      name,
      author,
      repo,
      description: blurb ? brief(blurb) : null,
      tags,
      devices: smk ? ['fm1', 'smk37'] : ['fm1'],
      homepage,
      image: img && /^https:/.test(img) ? img : null,
      links,
      release: version ? { version, date: day(attr('data-updated')) } : null,
      updated: day(attr('data-updated'))
    })
  }
  return out
}

// --- Reddit ---------------------------------------------------------------
// Makers announce firmware on the FM-1 and SMK-37 subreddits. Each post's GitHub repos (and github.io pages, which
// are user/repo) are leads, checked exactly like GitHub discovery: listed only with a release of its own that isn't a
// listed file. Leads are kept for a while (data/reddit.json), so a "coming soon" post is listed when it ships.

const SUBREDDITS = ['MVaveFM1', 'MvaveSmk']
const LEAD_DAYS = 90
// github.com paths that aren't repos
const NOT_OWNER = /^(orgs|sponsors|settings|features|topics|marketplace|apps|login|about|collections|notifications|users|enterprise|pricing|search|trending)$/i

// the repo a URL is about: github.com/user/repo/..., user.github.io/repo/...
function repoOfUrl(u) {
  let p
  try {
    p = new URL(u)
  } catch {
    return null
  }
  const host = p.hostname.toLowerCase().replace(/^www\./, '')
  const parts = p.pathname.split('/').filter(Boolean)
  if (host === 'github.com') return parts.length >= 2 && !NOT_OWNER.test(parts[0]) ? parseRepo(`${parts[0]}/${parts[1]}`) : null
  const io = host.match(/^([a-z0-9-]+)\.github\.io$/)
  if (io && parts[0]) return parseRepo(`${io[1]}/${parts[0]}`)
  return null
}

// one page of a subreddit's newest posts (the public feed; the JSON API wants a login): [{ id, url, date, links }]
async function redditPage(sub, after) {
  const url = `https://www.reddit.com/r/${sub}/new/.rss?limit=100${after ? `&after=${after}` : ''}`
  for (let tries = 0; tries < 4; tries++) {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) }).catch(() => null)
    if (r?.ok) {
      const x = await r.text()
      return [...x.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => {
        const html = decodeEntities(e.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1] || '')
        return {
          id: e.match(/<id>(t3_\w+)<\/id>/)?.[1],
          url: decodeEntities(e.match(/<link href="([^"]+)"/)?.[1] || ''),
          date: day(e.match(/<published>([^<]+)/)?.[1] || e.match(/<updated>([^<]+)/)?.[1]),
          links: [...html.matchAll(/href="([^"]+)"/g)].map((m) => decodeEntities(m[1]))
        }
      })
    }
    // too many requests: wait as long as Reddit asks (at most a minute), then once more
    if (r?.status !== 429 && r) break
    const wait = Math.min(60, Number(r?.headers.get('retry-after')) || 60)
    log(`  reddit: ${r ? 'rate limited' : 'no answer'}, waiting ${wait} s`)
    await sleep(wait * 1000)
  }
  log(`! could not fetch ${url}`)
  return null
}

const decodeEntities = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&amp;/g, '&')

async function fromReddit() {
  const cacheFile = new URL('reddit.json', OUT)
  const leads = JSON.parse(await readFile(cacheFile, 'utf8').catch(() => '{}'))
  let posts = 0
  for (const sub of SUBREDDITS) {
    let after = null
    // the newest 100 is a few days of posts (the sync runs daily); --full looks further back
    for (let page = 0; page < (FULL ? 10 : 1); page++) {
      if (posts) await sleep(30000) // gently: Reddit's feed allows about one read a minute without a login
      const list = await redditPage(sub, after)
      if (!list?.length) break
      posts += list.length
      for (const p of list) {
        for (const repo of new Set(p.links.map(repoOfUrl).filter(Boolean))) {
          const k = repoKey(repo)
          if (!leads[k] || leads[k].seen < p.date) leads[k] = { repo, post: p.url, seen: p.date }
        }
      }
      after = list[list.length - 1].id
      if (!after) break
    }
  }
  const since = day(new Date(Date.now() - LEAD_DAYS * 864e5).toISOString())
  for (const [k, l] of Object.entries(leads)) if (l.seen < since) delete leads[k]
  await writeFile(cacheFile, JSON.stringify(leads, null, 1) + '\n')
  log(`  reddit: ${posts} posts, ${Object.keys(leads).length} repos mentioned (last ${LEAD_DAYS} days)`)
  return Object.values(leads).map((l) => ({ src: 'reddit', repo: l.repo, name: l.repo.split('/')[1], kind: 'firmware', links: [], found: { reddit: l.post } }))
}

// --- GitHub ---------------------------------------------------------------

async function github(repos) {
  if (!TOKEN) {
    log('(no GITHUB_TOKEN, skipping GitHub refresh)')
    return {}
  }
  const info = {}
  const q = (alias, repo) => {
    const [owner, name] = repo.split('/')
    return `${alias}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
      nameWithOwner description homepageUrl defaultBranchRef { target { oid } } templateRepository { nameWithOwner } parent { nameWithOwner } isArchived pushedAt createdAt
      licenseInfo { spdxId } owner { login }
      usesCustomOpenGraphImage openGraphImageUrl
      releases(first: 50, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { tagName publishedAt url isPrerelease isDraft releaseAssets(first: 20) { nodes { name downloadUrl size digest } } } }
    }`
  }
  // a batch GitHub can't answer (a 502 on a big one) is split, never taken as "these repos are gone"
  const ask = async (batch) => {
    const d = await gql(`query { ${batch.map((r, j) => q(`r${j}`, r)).join('\n')} }`)
    if (!Object.keys(d).length) {
      if (batch.length > 1) {
        await ask(batch.slice(0, Math.ceil(batch.length / 2)))
        await ask(batch.slice(Math.ceil(batch.length / 2)))
      }
      return
    }
    batch.forEach((repo, k) => {
      info[repo.toLowerCase()] = d[`r${k}`] || false
    })
  }
  for (let i = 0; i < repos.length; i += 20) {
    await ask(repos.slice(i, i + 20))
    log(`  github ${Math.min(i + 20, repos.length)}/${repos.length}`)
  }
  return info
}

// --- GitHub discovery -------------------------------------------------------
// Repos nobody listed anywhere: GitHub searches, and the forks of every base and listing (and their forks).
// A fork only counts when its main branch has commits of its own and it made a release: forks for a pull request,
// and copies with nothing changed, are never their own thing.

const SEARCHES = ['m-vave in:name,description,readme', 'mvave in:name,description,readme', 'felucca in:name,description,readme', 'fwsc in:name,description,readme', 'smk-37 in:name,description', 'smk37 in:name,description,readme', '"fm-1" firmware in:name,description,readme', 'fm1 firmware in:name,description,readme', 'topic:fm1', 'topic:mvave']
// what a repo says about itself to be for the FM-1 or SMK-37 (M-VAVE alone is their other gear too; "FM1" next to more
// digits is other gear: FM150 radios, FM170 modems)
const ABOUT_FM1 = /fm-?1(?![0-9])|smk-?37|mke-?p37|felucca|sloop|\bfwsc\b/i
const TOOLISH = /emulat|editor|librar|recover|unbrick|restore|backup|install|flash|driver|plugin|vst|mirror|companion|controller|manager|console|template|\bsdk\b|toolchain|app\b|android|ios\b|mac|windows|tab5|esp32|rp20[0-9]{2}|pico|xiao|flipper|circuitpython/i
// a tool's tags, from what it says it is (TAGS.tool in src/entry.js)
const TOOL_TAGS = [
  ['sdk', /template|\bbase\b|\bsdk\b|toolchain|framework/i],
  ['emulator', /emulat|virtuali[sz]/i],
  ['editor', /editor/i],
  ['librarian', /librar/i],
  ['recovery', /recover|unbrick|restore|backup/i],
  ['installer', /install|flash/i],
  ['plugin', /plugin|vst|\bau\b|logue/i],
  ['hardware', /rp20[0-9]{2}|esp32|pico|xiao|tab5|flipper|circuitpython|uf2/i],
  ['app', /\bapp\b|android|ios\b|desktop|mac|windows/i]
]
// the FM-1's own firmware scene started in 2026: a repo untouched since before then is something else
const SCENE_START = '2026-06-01'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function ghRest(path) {
  for (let tries = 0; tries < 3; tries++) {
    const r = await fetch(`https://api.github.com${path}`, { headers: { ...UA, accept: 'application/vnd.github+json', authorization: `bearer ${TOKEN}` }, signal: AbortSignal.timeout(30000) }).catch(() => null)
    if (!r) continue
    if (r.ok) return r.json()
    if (r.status === 404 || r.status === 422) return null
    // rate limited: wait until GitHub says it's fine again (at most a minute)
    if (r.status === 403 || r.status === 429) {
      const reset = Number(r.headers.get('x-ratelimit-reset')) * 1000 - Date.now()
      const wait = Math.min(60000, Math.max(Number(r.headers.get('retry-after')) * 1000 || 0, reset || 0, 5000))
      log(`  github: rate limited, waiting ${Math.round(wait / 1000)} s`)
      await sleep(wait)
      continue
    }
    return null
  }
  return null
}

async function gql(query) {
  const r = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { ...UA, authorization: `bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(60000)
  }).catch(() => null)
  const j = r ? await r.json().catch(() => ({})) : {}
  if (!r || !r.ok) log(`  github graphql: ${r ? r.status : 'no answer'}`)
  if (j.errors && !j.data) log('  github error', JSON.stringify(j.errors).slice(0, 300))
  return j.data || {}
}

// repos (not forks: search leaves them out) that match the searches: Map repo -> how many forks it has
async function searchRepos() {
  const out = new Map()
  const search = async (q, page) => {
    const r = await ghRest(`/search/repositories?q=${encodeURIComponent(q)}&per_page=100&page=${page}`)
    await sleep(2100) // the search API allows 30 a minute
    return r
  }
  const dayOf = (t) => new Date(t).toISOString().slice(0, 10)
  // GitHub gives at most 1000 results a query: more than that is split by when the repos were made
  const run = async (q, from, to) => {
    const qq = from ? `${q} created:${from}..${to}` : q
    const first = await search(qq, 1)
    if (!first) return
    if (first.total_count > 1000 && (!from || from < to)) {
      const a = from ? Date.parse(from) : Date.parse('2024-01-01')
      const b = to ? Date.parse(to) : Date.now()
      const mid = dayOf(a + (b - a) / 2)
      await run(q, dayOf(a), mid)
      await run(q, dayOf(Date.parse(mid) + 864e5), dayOf(b))
      return
    }
    for (let page = 1, r = first; ;) {
      for (const it of r.items || []) if (!it.private) out.set(it.full_name, it.forks_count)
      if ((r.items || []).length < 100 || page >= 10) break
      r = await search(qq, ++page)
      if (!r) break
    }
  }
  for (const q of SEARCHES) await run(q)
  return out
}

// every fork of these repos, and of their forks: { repo, parent, parentBranch, branch, createdAt, pushedAt, releases }
async function forksOf(roots) {
  const seen = new Set(roots.map(repoKey))
  const out = []
  let todo = roots.map((repo) => ({ repo, after: null }))
  while (todo.length) {
    const next = []
    const ask = async (batch) => {
      const query = `query { ${batch
        .map(({ repo, after }, j) => {
          const [owner, name] = repo.split('/')
          return `r${j}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { nameWithOwner defaultBranchRef { name }
            forks(first: 100${after ? `, after: ${JSON.stringify(after)}` : ''}) { pageInfo { hasNextPage endCursor }
              nodes { nameWithOwner isPrivate createdAt pushedAt forkCount defaultBranchRef { name } releases { totalCount } } } }`
        })
        .join('\n')} }`
      const d = await gql(query)
      // too big for GitHub this time (it answers 502): halves
      if (!Object.keys(d).length && batch.length > 1) {
        await ask(batch.slice(0, batch.length / 2))
        await ask(batch.slice(batch.length / 2))
        return
      }
      batch.forEach((b, j) => {
        const p = d[`r${j}`]
        if (!p) return
        for (const f of p.forks.nodes) {
          if (f.isPrivate || seen.has(repoKey(f.nameWithOwner))) continue
          seen.add(repoKey(f.nameWithOwner))
          out.push({ repo: f.nameWithOwner, parent: p.nameWithOwner, parentBranch: p.defaultBranchRef?.name, branch: f.defaultBranchRef?.name, createdAt: f.createdAt, pushedAt: f.pushedAt, releases: f.releases.totalCount })
          if (f.forkCount) next.push({ repo: f.nameWithOwner, after: null })
        }
        if (p.forks.pageInfo.hasNextPage) next.push({ repo: b.repo, after: p.forks.pageInfo.endCursor })
      })
    }
    for (let i = 0; i < todo.length; i += 4) {
      await ask(todo.slice(i, i + 4))
      if (i % 100 === 0) log(`  forks: ${out.length} so far (${todo.length - i} repos left this round)`)
    }
    todo = next
  }
  return out
}

// how many commits a fork's main branch has that its parent's doesn't (null: GitHub couldn't say)
async function aheadBy(f) {
  if (!f.branch || !f.parentBranch) return null
  const [owner, name] = f.repo.split('/')
  const r = await ghRest(`/repos/${f.parent}/compare/${encodeURIComponent(f.parentBranch)}...${owner}:${name}:${encodeURIComponent(f.branch)}?per_page=1`)
  return r ? r.ahead_by : null
}

// repos to look at: { src: 'github', repo, name, found: { fork, ahead } }
async function fromGithub(roots) {
  if (!TOKEN) {
    log('(no GITHUB_TOKEN, skipping GitHub discovery)')
    return []
  }
  const cacheFile = new URL('discover.json', OUT)
  const cache = JSON.parse(await readFile(cacheFile, 'utf8').catch(() => '{}'))
  const hits = await searchRepos()
  log(`  github search: ${hits.size} repos`)
  const forks = await forksOf([...new Set([...roots, ...[...hits].filter(([, n]) => n > 0).map(([repo]) => repo)])])
  // a fork that was never pushed to, or never made a release, has nothing to install: not even worth asking
  const maybe = forks.filter((f) => f.releases > 0 && f.pushedAt > f.createdAt)
  log(`  github forks: ${forks.length}, with a release of their own: ${maybe.length}`)
  const items = []
  for (const f of maybe) {
    const c = cache[repoKey(f.repo)]
    const ahead = c && c.pushedAt === f.pushedAt ? c.ahead : await aheadBy(f)
    if (ahead != null) cache[repoKey(f.repo)] = { pushedAt: f.pushedAt, ahead }
    if (!ahead) continue // nothing of its own (or unknown): not a separate firmware
    items.push({ src: 'github', repo: f.repo, name: f.repo.split('/')[1], kind: 'firmware', links: [], found: { fork: f.parent, ahead } })
  }
  log(`  github forks with changes of their own: ${items.length}`)
  for (const repo of hits.keys()) items.push({ src: 'github', repo, name: repo.split('/')[1], kind: 'firmware', links: [], found: {} })
  await writeFile(cacheFile, JSON.stringify(cache) + '\n')
  return items
}

const BASE_REPO_OF = Object.fromEntries(Object.entries(BASE_INFO).map(([k, v]) => [k, v.repo]))

const rel = (r) =>
  r && {
    version: r.tagName,
    date: day(r.publishedAt),
    url: r.url,
    prerelease: r.isPrerelease || undefined,
    assets: pickAssets(r.releaseAssets.nodes.map((a) => ({ name: a.name, url: a.downloadUrl, size: a.size, digest: a.digest })))
  }

// --- merge ----------------------------------------------------------------

// sources in order of trust for text fields
const RANK = { user: 0, firmwarehub: 1, 'fm1-editor': 2, fmdb: 3, github: 4, reddit: 5 }
// found by us (GitHub discovery, Reddit), not listed on another hub
const FOUND = new Set(['github', 'reddit'])
const foundOnly = (e) => e.sources.every((s) => FOUND.has(s))

function keyOf(e) {
  if (e.repo) return repoKey(e.repo)
  const u = cleanUrl(e.homepage) || cleanUrl(e.links?.[0]?.url)
  if (u) {
    const p = new URL(u)
    const host = p.hostname.replace(/^www\./, '')
    return 'url:' + (host.endsWith('github.io') ? host + '/' + p.pathname.split('/')[1] : host)
  }
  return 'name:' + slugify(e.name)
}

function dedupeVersions(list) {
  const out = new Map()
  for (const v of list) {
    if (!v?.version) continue
    const k = String(v.version).replace(/^v(?=\d)/i, '')
    const old = out.get(k)
    if (!old || (!old.assets?.length && v.assets?.length)) out.set(k, { ...old, ...v })
  }
  return [...out.values()]
}

// entries without a repo: same if they share a (specific) host or a squashed name
const GENERIC_HOST = /(^|\.)(reddit|youtube|youtu|github|discord|instagram|patreon|ko-fi|gumroad|itch|m-vave|google|drive\.google)\.(com|be|io|gg)$/
function looseKeys(e) {
  const keys = ['n:' + slugify(e.name.replace(/\(.*?\)/g, '')).replace(/-/g, '')]
  if (e.loose) keys.push('k:' + e.loose)
  for (const u of [e.homepage, ...(e.links || []).map((l) => l.url)]) {
    const c = cleanUrl(u)
    if (!c) continue
    const host = new URL(c).hostname.replace(/^www\./, '')
    if (!GENERIC_HOST.test(host) && !host.endsWith('github.io')) keys.push('h:' + host)
  }
  return keys
}

function groupLoose(items) {
  const parent = items.map((_, i) => i)
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const owner = new Map()
  items.forEach((it, i) => {
    for (const k of looseKeys(it)) {
      if (owner.has(k)) parent[find(i)] = find(owner.get(k))
      else owner.set(k, i)
    }
  })
  const out = new Map()
  items.forEach((it, i) => {
    const r = find(i)
    if (!out.has(r)) out.set(r, [])
    out.get(r).push(it)
  })
  return [...out.values()]
}

function merge(items) {
  items.sort((a, b) => RANK[a.src] - RANK[b.src])
  const first = (k) => items.map((i) => i[k]).find((v) => v != null && v !== '' && !(Array.isArray(v) && !v.length))
  const links = []
  const seen = new Set()
  for (const i of items) {
    for (const l of i.links || []) {
      const url = cleanUrl(l.url)
      if (!url || seen.has(url) || url === cleanUrl(first('homepage'))) continue
      if (/github\.com\//.test(url) && parseRepo(url)?.toLowerCase() === repoKey(first('repo'))) continue
      seen.add(url)
      links.push({ label: l.label, url })
    }
  }
  const releases = items.map((i) => i.release).filter(Boolean)
  return {
    kind: items.some((i) => i.kind === 'firmware') ? 'firmware' : 'tool',
    name: first('name'),
    author: first('author'),
    repo: first('repo') || null,
    description: first('description') ? decode(first('description')) : null,
    devices: [...new Set(items.flatMap((i) => i.devices || []))],
    tags: [...new Set(items.flatMap((i) => i.tags || []))],
    base: first('base') || null,
    license: first('license') || null,
    homepage: cleanUrl(first('homepage')),
    image: first('image') || null,
    card: first('card') || null,
    links: links.slice(0, 12),
    release: releases.find((r) => r.assets?.length) || releases[0] || null,
    hid: items.find((i) => i.hid)?.hid,
    stock: items.some((i) => i.stock) || undefined,
    beta: items.every((i) => i.beta) || undefined,
    added: minDay(...items.map((i) => i.added)),
    updated: maxDay(...items.map((i) => i.updated), ...releases.map((r) => r.date)),
    sources: [...new Set(items.map((i) => i.src))],
    _page: items.flatMap((i) => i.pageFiles || []),
    _hubPkg: items.find((i) => i.hubPkg)?.hubPkg,
    _versions: dedupeVersions([...items.flatMap((i) => i.history || []), ...releases]),
    _ids: items.map((i) => i.srcId).filter(Boolean),
    _found: items.find((i) => i.found)?.found
  }
}

function applyGithub(e, g) {
  if (!g) return e
  e.repo = g.nameWithOwner
  e.description = e.description || g.description || null
  e.homepage = e.homepage || cleanUrl(g.homepageUrl)
  e.license = e.license || (g.licenseInfo?.spdxId !== 'NOASSERTION' ? g.licenseInfo?.spdxId : null) || null
  e.author = e.author || g.owner.login
  if (g.isArchived) e.archived = true
  // lineage on GitHub (made from a base's template, or a fork of it) beats what the other hubs said
  const base = baseOfRepo(g.templateRepository?.nameWithOwner, g.parent?.nameWithOwner)
  if (base && repoKey(e.repo) !== repoKey(BASE_REPO_OF[base])) e.base = base
  if (!e.image && g.usesCustomOpenGraphImage) e.image = g.openGraphImageUrl
  const all = g.releases.nodes.filter((r) => !r.isDraft).map(rel)
  if (all.length) {
    e._versions = all
    e._vsrc = 'github'
  }
  const latest = all.find((r) => !r.prerelease)
  const newest = all[0]
  if (latest) e.release = latest
  if (newest && newest.prerelease && (!latest || newest.date > latest.date)) {
    if (latest) e.prerelease = newest
    else e.release = newest
  }
  e.added = minDay(e.added, g.createdAt)
  e.updated = maxDay(e.updated, g.pushedAt, e.release?.date)
  return e
}

// --- packages outside GitHub releases ------------------------------------
// 1. on the maker's own site, found (and checked) by FMDB
// 2. committed in the repo: only if its sha256 matches what The Firmware Hub checked, linked at that commit

const hasFwsc = (r) => (r?.assets || []).some((a) => /\.fwsc$/i.test(a.name))

async function findHostedPackages(entries, gh) {
  let fromPages = 0
  let fromTree = 0
  for (const e of entries) {
    if (hasFwsc(e.release)) continue
    const v = String(e.release?.version || '').replace(/^v/i, '')
    const page = e._page || []
    const pick = (v && page.filter((a) => a.name.includes(v))) || []
    let files = pick.length ? pick : page.slice(0, 1)
    for (const f of files) {
      if (!PKG.has(f.url)) {
        const k = KNOWN_SHA.get(f.url)
        const c = await inspect(f.url, { digest: k?.digest, headers: UA }).catch(() => undefined)
        if (c !== undefined) PKG.set(f.url, c || false)
      }
    }
    files = files.filter((f) => PKG.get(f.url))
    if (files.length) {
      e.release = { ...(e.release || { version: v || 'latest' }), assets: files }
      fromPages++
      continue
    }
    const want = e._hubPkg
    const oid = gh[e.key]?.defaultBranchRef?.target?.oid
    if (!want || !oid || !TOKEN) continue
    const tree = await fetch(`https://api.github.com/repos/${e.repo}/git/trees/${oid}?recursive=1`, { headers: { ...UA, authorization: `bearer ${TOKEN}` } })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
    // the newest .fwsc in the repo (not in old/archive folders), named like the Hub's copy if possible
    const stem = want.file.replace(/[-_]v?\d.*$/, '').toLowerCase()
    const all = (tree?.tree || []).filter((t) => t.type === 'blob' && /\.fwsc$/i.test(t.path) && !/(^|\/)(old|older|archive|legacy|deprecated|backup)s?\//i.test(t.path))
    const named = all.filter((t) => t.path.split('/').pop().toLowerCase().startsWith(stem))
    const newest = (named.length ? named : all).map((t) => t.path).sort((x, y) => y.localeCompare(x, undefined, { numeric: true }))[0]
    if (!newest) continue
    const url = `https://raw.githubusercontent.com/${e.repo}/${oid}/${newest.split('/').map(encodeURIComponent).join('/')}`
    const c = PKG.get(url) ?? (await inspect(url, { headers: UA }).catch(() => undefined))
    if (c !== undefined) PKG.set(url, c || false)
    // same device family as the package the Hub checked
    if (c && c.product.split('_')[0] === String(want.product).split('_')[0]) {
      const file = newest.split('/').pop()
      const fv = file.match(/[-_]v?(\d[\w.+-]*)\.fwsc$/i)?.[1]
      e.release = { ...(e.release || {}), version: c.sha256 === want.sha256 ? e.release?.version || fv || 'latest' : fv || e.release?.version || 'latest', assets: [{ name: file, url }] }
      fromTree++
    }
  }
  // the history needs the same files, or its newest version (with no files) hides them
  for (const e of entries) {
    if (!hasFwsc(e.release)) continue
    e._versions = e._versions || []
    const norm = (x) => String(x).replace(/^v(?=\d)/i, '')
    const v = e._versions.find((x) => norm(x.version) === norm(e.release.version))
    if (!v) e._versions.push({ ...e.release })
    else if (!hasFwsc(v)) v.assets = e.release.assets
  }
  log(`  packages found on makers' sites: ${fromPages}, in repos: ${fromTree}`)
}

// --- package checks -------------------------------------------------------

async function checkPackages(entries) {
  const cacheFile = new URL('pkgcache.json', OUT)
  for (const [url, c] of Object.entries(JSON.parse(await readFile(cacheFile, 'utf8').catch(() => '{}')))) PKG.set(url, c)
  const live = await get(`${SITE}/catalog.json`)
  for (const f of [...(live?.firmwares || []), ...(live?.stock ? [live.stock] : [])]) {
    seedPkg(f.pkg, f)
    if (f.sha256) LISTED_SHA.add(f.sha256)
    addProduct(f.repo, f.product)
  }

  // the latest release (and pre-release) of every entry
  const todo = new Map()
  for (const e of entries) {
    for (const a of [...(e.release?.assets || []), ...(e.prerelease?.assets || [])]) {
      // (and FM-1 packages checked before the flash chip check)
      if (/\.fwsc$/i.test(a.name) && (!PKG.has(a.url) || needsChip(PKG.get(a.url)))) todo.set(a.url, a)
    }
  }
  log(`checking ${todo.size} packages (${PKG.size} known)…`)
  const list = [...todo.values()]
  let done = 0
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (list.length) {
        const a = list.shift()
        const k = KNOWN_SHA.get(a.url)
        // (a download that failed isn't remembered, so the next run tries again)
        const c = await inspect(a.url, { digest: a._digest || k?.digest, headers: UA }).catch(() => undefined)
        if (c !== undefined) PKG.set(a.url, c || false)
        if (++done % 50 === 0) log(`  ${done}/${todo.size}`)
      }
    })
  )
  await writeFile(cacheFile, JSON.stringify(Object.fromEntries(PKG)) + '\n')

  // put the results on every asset (latest, pre-release, history), and learn devices from them
  for (const e of entries) {
    const lists = [e.release?.assets, e.prerelease?.assets, ...(e._versions || []).map((v) => v.assets)]
    for (const assets of lists) {
      for (const a of assets || []) {
        delete a._digest
        const c = PKG.get(a.url)
        if (c) Object.assign(a, c)
      }
    }
    const found = [...(e.release?.assets || []), ...(e.prerelease?.assets || [])].map((a) => deviceOf(a.product)).filter(Boolean)
    if (found.length) e.devices = [...new Set([...e.devices, ...found])]
  }
  const ok = [...PKG.values()].filter(Boolean).length
  log(`  ${ok} installable packages`)
}

// --- what's listed already -------------------------------------------------

// the database's entries (hidden ones too): their ids, repos, and the loose keys of those without a repo
function listed() {
  // (Cloudflare's API fails a read now and then: a few tries before giving up)
  let out = null
  for (let i = 0; i < 4 && out === null; i++) {
    if (i) spawnSync('sleep', [String(5 * i)])
    out = wrangler(['d1', 'execute', DB_NAME, '--remote', '--json', '--command', 'SELECT id, repo, auto, data FROM entries'], { quiet: true, allowFail: true })
  }
  if (out === null) return null
  const rows = parseJson(out)[0]?.results || []
  const db = { ids: new Set(), repos: new Map(), loose: new Set(), keys: new Map(), pages: new Set() }
  for (const r of rows) {
    const e = { ...JSON.parse(r.auto || '{}'), ...JSON.parse(r.data || '{}') }
    db.ids.add(r.id)
    for (const repo of [r.repo, e.repo].filter(Boolean)) db.repos.set(repoKey(repo), r.id)
    if (!r.repo && !e.repo && e.name) for (const k of looseKeys(e)) db.loose.add(k)
    if (!r.repo && !e.repo) for (const u of [e.homepage, ...(e.links || []).map((l) => l.url)]) if (u && repoOfUrl(u)) db.pages.add(repoKey(repoOfUrl(u)))
    db.keys.set(e.repo ? repoKey(e.repo) : keyOf({ name: e.name || r.id, homepage: e.homepage, links: e.links }), r.id)
  }
  return db
}

// --- main -----------------------------------------------------------------

async function main() {
  await mkdir(OUT, { recursive: true })

  // ids already in use, so they stay stable between runs
  const known = new Map()
  const db = listed()
  if (!db && !FULL) throw new Error("can't read the database (is wrangler logged in? try `npx wrangler login`)")
  const prev = JSON.parse(await readFile(new URL('auto.json', OUT), 'utf8').catch(() => '{"entries":[]}'))
  for (const e of prev.entries || []) known.set(e.key || keyOf(e), e.id)
  const live = db ? null : await get(`${SITE}/firmware.json`)
  for (const e of live?.entries || []) known.set(keyOf(e), e.id)
  for (const [k, id] of db?.keys || []) known.set(k, id)
  const liveRepos = db ? [...db.repos.keys()] : (live?.entries || []).filter((e) => e.repo).map((e) => e.repo)

  log('fetching sources…')
  const [hub, fmdb, ed] = await Promise.all([fromHub(), fromFmdb(), fromFm1Editor()])
  log(`  firmwarehub ${hub.length}, fmdb ${fmdb.length}, fm1-editor ${ed.length}`)
  // (every listing's forks too, so the walk starts from the bases and from everything listed)
  const roots = [...new Set([...Object.values(BASE_REPO_OF).filter(Boolean), ...liveRepos, ...[...hub, ...ed, ...fmdb].map((i) => i.repo).filter(Boolean)])]
  const found = [...(await fromGithub(roots)), ...(await fromReddit())]

  const groups = new Map()
  const withRepo = [...hub, ...ed, ...fmdb, ...found].filter((i) => i.repo)
  for (const item of withRepo) {
    const k = keyOf(item)
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(item)
  }
  for (const g of groupLoose([...hub, ...ed, ...fmdb].filter((i) => !i.repo))) {
    groups.set(keyOf(g.find((i) => i.homepage) || g[0]), g)
  }
  if (FULL) {
    // entries people added by hand get GitHub refreshes too
    for (const repo of liveRepos) {
      const k = repoKey(repo)
      if (!groups.has(k)) groups.set(k, [{ src: 'user', repo, links: [] }])
    }
  } else {
    // only what isn't listed yet
    for (const [k, items] of [...groups]) {
      const isRepo = !/^(url|name):/.test(k)
      if (isRepo ? db.repos.has(k) : items.some((i) => looseKeys(i).some((x) => db.loose.has(x)))) groups.delete(k)
    }
    log(`  ${groups.size} not listed yet`)
  }

  // ask GitHub about every repo first: renamed repos collapse into one entry
  const gh = await github([...groups.keys()].filter((k) => !/^(url|name):/.test(k)))
  const canon = new Map()
  const renamed = new Map() // old repo key -> new (GitHub redirects renamed and transferred repos)
  for (const [key, items] of groups) {
    const c = gh[key] ? gh[key].nameWithOwner.toLowerCase() : key
    if (gh[key] && c !== key) renamed.set(key, c)
    if (!canon.has(c)) canon.set(c, [])
    canon.get(c).push(...items)
    if (gh[key]) gh[c] = gh[key]
  }
  // (a repo listed under its new name already, after a rename, isn't new either)
  if (!FULL) {
    for (const k of [...canon.keys()]) {
      if (db.repos.has(k)) {
        log(`  skip ${k}: listed already (renamed on GitHub)`)
        canon.delete(k)
      }
    }
  }
  if (!FULL) renamed.clear()
  let entries = [...canon.entries()].map(([key, items]) => ({ key, ...merge(items) }))
  // repos GitHub no longer has, and only one source vouches for, are dropped
  for (const e of entries) if (e.repo && gh[e.key] === false && e.sources.every((s) => s === 'user' || s === 'fmdb' || FOUND.has(s))) log(`  skip ${e.repo}: gone from GitHub (deleted or private)`)
  entries = entries.filter((e) => !(e.repo && gh[e.key] === false && e.sources.every((s) => s === 'user' || s === 'fmdb' || FOUND.has(s))))
  for (const e of entries) applyGithub(e, gh[e.key])
  await findHostedPackages(entries, gh)

  await checkPackages(entries)

  // what GitHub discovery alone found is listed automatically, or not at all (nobody reviews a queue):
  // - firmware: its latest release has an installable FM-1 / SMK-37 package that isn't a listed file
  // - a tool: it says it's for the FM-1 / SMK-37 in its name or description, was worked on since that had firmware of
  //   its own, and its latest release has files
  // Never: forks under their parent's name (someone's build of it), copies, packages for other gear on the same chip.
  // One listed wrongly is hidden by an admin, and stays hidden (the sync never adds a listed repo again).
  // (packages for the FM-1 and the SMK-37 family only: the same chip runs other makers' gear too)
  const pkgs = (e) => [...(e.release?.assets || []), ...(e.prerelease?.assets || [])].filter((a) => a.sha256 && a.product && deviceOf(a.product))
  for (const e of entries) {
    if (foundOnly(e)) continue
    for (const a of pkgs(e)) {
      LISTED_SHA.add(a.sha256)
      addProduct(e.repo, a.product)
    }
  }
  const skipped = {}
  const skip = (why) => {
    skipped[why] = (skipped[why] || 0) + 1
    return false
  }
  entries = entries.filter((e) => {
    if (!foundOnly(e) || db?.repos.has(e.key)) return true
    // (a listing without a repo whose page is this repo's github.io site is this firmware)
    if (db?.pages.has(e.key)) return skip('listed already, by its page')
    const fork = e._found?.fork
    const sameName = fork && fork.split('/')[1].toLowerCase() === e.key.split('/')[1]
    const files = [...(e.release?.assets || []), ...(e.prerelease?.assets || [])]
    if (files.some((a) => a.product && !deviceOf(a.product))) return skip('a package for other gear')
    const mine = pkgs(e)
    if (mine.length) {
      if (mine.every((a) => LISTED_SHA.has(a.sha256))) return skip('a copy of a listed package')
      // under its parent's name: its own firmware only with a device id of its own (a build of the parent keeps the
      // parent's), and then named after its owner too, so it isn't taken for the original
      if (sameName) {
        const theirs = LISTED_PRODUCTS.get(repoKey(fork))
        if (!theirs || mine.some((a) => theirs.has(a.product))) return skip('a build of its parent (its name and device id)')
        e.name = `${e.name} (${e.key.split('/')[0]})`
      }
      for (const a of mine) LISTED_SHA.add(a.sha256)
      return true
    }
    if (sameName) return skip("a fork under its parent's name")
    const text = `${e.key.split('/')[1]} ${e.name} ${e.description || ''}`
    if (!files.length) return skip(e.release || e.prerelease ? 'a release without files' : 'no release')
    if (!ABOUT_FM1.test(text) || (e.updated || '') < SCENE_START) return skip('not about the FM-1 / SMK-37')
    // a tool (an emulator, an editor, a recovery helper, ...), unless it calls itself firmware
    const firmware = !TOOLISH.test(text) && (/firmware/i.test(text) || files.some((a) => /\.(fwsc|bin|hex)$/i.test(a.name)))
    e.kind = firmware ? 'firmware' : 'tool'
    if (!firmware)
      e.tags = TOOL_TAGS.filter(([, re]) => re.test(text))
        .map(([t]) => t)
        .slice(0, 2)
    if (/smk-?37|mke-?p37/i.test(text)) e.devices = [...new Set([...e.devices, 'smk37'])]
    if (!e.devices.length) e.devices = ['fm1']
    return true
  })
  const listedNow = entries.filter(foundOnly)
  log(
    `  github + reddit discovery: listing ${listedNow.filter((e) => e.kind === 'firmware').length} firmwares and ${listedNow.filter((e) => e.kind === 'tool').length} tools; skipped ${
      Object.entries(skipped)
        .map(([k, n]) => `${n} (${k})`)
        .join(', ') || 'none'
    }`
  )

  // assign ids
  const versions = new Map()
  // (the site's own paths can't be ids: listings live at mutant.cloud/<id>)
  const used = new Set([...known.values(), ...(db?.ids || []), ...RESERVED])
  for (const e of entries) {
    let id = known.get(e.key)
    if (!id) {
      const wants = [...e._ids, slugify(e.name), e.repo && slugify(`${e.name}-${e.repo.split('/')[0]}`)].filter(Boolean)
      id = wants.find((w) => !used.has(w))
      for (let n = 2; !id; n++) if (!used.has(`${wants[0]}-${n}`)) id = `${wants[0]}-${n}`
      used.add(id)
    }
    e.id = id
    delete e._ids
    delete e._page
    delete e._hubPkg
    versions.set(id, { list: e._versions || [], src: e._vsrc || e.sources[0] })
    delete e._versions
    delete e._vsrc
    delete e._found
    for (const k of Object.keys(e)) if (e[k] === undefined || e[k] === null) delete e[k]
  }
  entries.sort((a, b) => a.id.localeCompare(b.id))

  // (screenshots aren't stored here: the worker reads public/shots/index.json itself)

  const now = new Date().toISOString()
  await writeFile(new URL('auto.json', OUT), JSON.stringify({ updated: now, entries }, null, 1) + '\n')

  // SQL: refresh only the auto column; data (hand edits) is never touched
  const q = (s) => (s == null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`)
  const sql = []
  // follow renames/transfers first (only GitHub can move a listing to another repo), unless the new name is listed already
  for (const [from, to] of renamed) {
    sql.push(`UPDATE entries SET repo = ${q(to)} WHERE repo = ${q(from)} AND NOT EXISTS (SELECT 1 FROM entries WHERE repo = ${q(to)});`)
  }
  if (renamed.size) log(`  following ${renamed.size} renamed/transferred repos`)
  for (const e of entries) {
    const { key, id, ...auto } = e
    const json = q(JSON.stringify(auto))
    const repo = q(e.repo ? repoKey(e.repo) : null)
    if (e.repo) {
      sql.push(`UPDATE entries SET auto = ${json}, synced = ${q(now)} WHERE repo = ${repo};`)
      sql.push(`INSERT INTO entries (id, repo, auto, created, updated, synced) SELECT ${q(id)}, ${repo}, ${json}, ${q(now)}, ${q(now)}, ${q(now)} WHERE NOT EXISTS (SELECT 1 FROM entries WHERE repo = ${repo} OR id = ${q(id)});`)
    } else {
      sql.push(`INSERT INTO entries (id, repo, auto, created, updated, synced) VALUES (${q(id)}, NULL, ${json}, ${q(now)}, ${q(now)}, ${q(now)}) ON CONFLICT(id) DO UPDATE SET auto = excluded.auto, synced = excluded.synced;`)
    }
  }
  // version history: added, never removed; hand-added versions are never overwritten
  let nv = 0
  for (const e of entries) {
    const target = e.repo ? `FROM entries WHERE repo = ${q(repoKey(e.repo))}` : `FROM entries WHERE id = ${q(e.id)}`
    const { list, src: from } = versions.get(e.id)
    const src = q(from === 'user' ? 'github' : from)
    for (const v of list) {
      nv++
      sql.push(`INSERT INTO releases (entry, version, date, url, prerelease, assets, source, added) SELECT id, ${q(v.version)}, ${q(v.date)}, ${q(v.url)}, ${v.prerelease ? 1 : 0}, ${q(JSON.stringify(v.assets || []))}, ${src}, ${q(now)} ${target} ON CONFLICT(entry, version) DO UPDATE SET date = COALESCE(excluded.date, releases.date), url = COALESCE(excluded.url, releases.url), prerelease = excluded.prerelease, assets = CASE WHEN excluded.assets = '[]' THEN releases.assets ELSE excluded.assets END WHERE releases.source NOT IN ('manual', 'action', 'removed');`)
    }
  }
  log(`  ${nv} versions`)
  await writeFile(new URL('auto.sql', OUT), sql.join('\n') + '\n')
  const by = (k) => entries.filter(k).length
  if (!FULL) log(entries.length ? `${entries.length} new: ${entries.map((e) => e.name).join(', ')}` : 'nothing new to add')
  log(`wrote ${entries.length} entries (${by((e) => e.kind === 'tool')} tools, ${by((e) => e.devices.includes('smk37'))} on SMK-37, ${by((e) => !e.repo)} without a repo)`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
