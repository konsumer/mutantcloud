import { authorKey, DEVICES, KINDS, TAGS, BASES, BASE_INFO, baseOfRepo, isAdmin, FILTERS, matches, RESERVED, parseDeviceId, slugify, repoKey, repoOwner, cleanInput, cleanUrl, effective, canManage } from './entry.js'
import { inspect, check, needsChip, deviceOf } from './pkg.js'

const SESSION_COOKIE = 'mc_session'
const STATE_COOKIE = 'mc_oauth'
const SESSION_TTL = 60 * 60 * 24 * 30
const LIST_TTL = 300
const CREATE_LIMIT = 20 // new entries per person per day

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    try {
      const res = await route(request, env, ctx, url)
      if (res) return res
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, ...e.extra }, e.status)
      console.error(e)
      return json({ error: 'something broke' }, 500)
    }
    return env.ASSETS.fetch(request)
  },

  // every 10 minutes (wrangler.jsonc "triggers"): look for new releases of listed repos
  async scheduled(event, env, ctx) {
    ctx.waitUntil(watch(env).catch((e) => console.error('watch failed', e)))
  }
}

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message)
    this.status = status
    this.extra = extra
  }
}

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body, null, 1), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', ...headers }
  })

const admins = (env) =>
  String(env.ADMINS || '')
    .split(/[\s,]+/)
    .filter(Boolean)

async function route(request, env, ctx, url) {
  const { pathname } = url
  const method = request.method

  if (method === 'OPTIONS') {
    return new Response(null, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET', 'access-control-max-age': '86400' } })
  }

  if ((pathname === '/firmware.json' || pathname === '/api/entries' || pathname === '/catalog.json') && (method === 'GET' || method === 'HEAD')) {
    return listResponse(request, env, ctx, url)
  }

  if ((pathname === '/feed.xml' || pathname === '/rss.xml' || pathname === '/feed' || pathname === '/rss') && (method === 'GET' || method === 'HEAD')) {
    return feed(request, env, ctx, url)
  }

  // the site itself, with the whole list inlined in its HTML: the first load paints from one response, with no
  // second request (or round trip) for /firmware.json
  if ((pathname === '/' || pathname === '/index.html') && method === 'GET') return homePage(request, env, ctx, url)

  // what search engines read: every listing's own page
  if (pathname === '/sitemap.xml' && (method === 'GET' || method === 'HEAD')) return sitemap(request, env, ctx, url)

  if (pathname === '/auth/login') return login(request, env, url)
  if (pathname === '/auth/callback') return callback(request, env, url)
  if (pathname === '/auth/logout') {
    sameOrigin(request, url)
    return logout(request, env)
  }

  // a listed package with CORS on (mutant.cloud/dl/<id>/<file>), for browser apps that can't read GitHub's downloads
  const dl = pathname.match(/^\/dl\/([a-z0-9-]+)\/([^/]+)$/)
  if (dl && (method === 'GET' || method === 'HEAD')) return download(request, env, ctx, dl[1], decodeURIComponent(dl[2]))

  // a listing's own link (mutant.cloud/<id>): the site, with that listing's name, description and picture in its
  // preview tags. Anything else falls through to the static files (and the site itself).
  const share = pathname.match(/^\/([a-z0-9-]+)\/?$/)
  if (share && !RESERVED.has(share[1]) && (method === 'GET' || method === 'HEAD')) return listingPage(request, env, url, share[1])

  if (!pathname.startsWith('/api/')) return null
  // /api/publish is called from GitHub Actions (OIDC token, no cookies), everything else is same-site only
  if (method !== 'GET' && pathname !== '/api/publish') sameOrigin(request, url)

  if (pathname === '/api/me') return me(request, env)
  if (pathname === '/api/ids' && method === 'GET') return deviceIdsResponse(env, url)
  if (pathname === '/api/publish' && method === 'POST') return publish(request, env)
  // admins: run the release watcher now (it also runs by itself every 10 minutes)
  if (pathname === '/api/admin/watch' && method === 'POST') {
    const user = await requireUser(request, env)
    if (!isAdmin(user, admins(env))) throw new HttpError(403, 'admins only')
    const result = await watch(env)
    if (result.added.length) await purge(request, env)
    return json(result)
  }

  // admins: who signs in and edits, and which listings release most
  if (pathname === '/api/admin/activity' && method === 'GET') {
    const user = await requireUser(request, env)
    if (!isAdmin(user, admins(env))) throw new HttpError(403, 'admins only')
    return activity(env)
  }

  if (pathname === '/api/entries' && method === 'POST') return create(request, env, ctx)

  const r = pathname.match(/^\/api\/entries\/([a-z0-9-]+)\/releases(?:\/(.+))?$/)
  if (r) {
    const [, id, version] = r
    if (!version && method === 'GET') return json(await versions(env, id))
    if (!version && method === 'POST') return addVersion(request, env, id)
    if (version && method === 'DELETE') return removeVersion(request, env, id, decodeURIComponent(version))
  }

  const m = pathname.match(/^\/api\/entries\/([a-z0-9-]+)(\/refresh|\/history)?$/)
  if (m) {
    const [, id, sub] = m
    if (!sub && method === 'GET') return getOne(env, id)
    if (!sub && method === 'PATCH') return edit(request, env, ctx, id)
    if (!sub && method === 'DELETE') return remove(request, env, ctx, id)
    if (sub === '/refresh' && method === 'POST') return refresh(request, env, ctx, id)
    if (sub === '/history' && method === 'GET') return history(request, env, id)
  }
  throw new HttpError(404, 'no such endpoint')
}

// browsers send Origin on cross-site POST/PATCH/DELETE; refuse anything not from here
function sameOrigin(request, url) {
  const origin = request.headers.get('origin')
  if (origin !== url.origin) throw new HttpError(403, 'cross-origin request refused')
}

// --- list -----------------------------------------------------------------

const parseRel = (r) => r && { version: r.version, date: r.date || undefined, url: r.url || undefined, prerelease: r.prerelease ? true : undefined, assets: JSON.parse(r.assets || '[]') }

// newest release + newest pre-release per entry, from the history table
const LATEST = `SELECT entry, version, date, url, prerelease, assets, n FROM (
  SELECT r.*, ROW_NUMBER() OVER (PARTITION BY entry, prerelease ORDER BY (assets LIKE '%"sha256"%') DESC, date DESC, added DESC) AS rn, COUNT(*) OVER (PARTITION BY entry) AS n FROM releases r WHERE source <> 'removed'
) WHERE rn = 1`
// the newest (non-pre) release by date, installable or not: if it isn't the one shown, the site says why
const NEWEST = `SELECT entry, version, date, url, prerelease, assets FROM (
  SELECT r.*, ROW_NUMBER() OVER (PARTITION BY entry ORDER BY date DESC, added DESC) AS rn FROM releases r WHERE source <> 'removed' AND prerelease = 0
) WHERE rn = 1`

function attachLatest(list, latest, newest = []) {
  const by = new Map()
  for (const l of latest) {
    const x = by.get(l.entry) || { count: l.n }
    x[l.prerelease ? 'prerelease' : 'release'] = parseRel(l)
    by.set(l.entry, x)
  }
  for (const l of newest) {
    const x = by.get(l.entry)
    if (x) x.newest = parseRel(l)
  }
  for (const row of list) row.latest = by.get(row.id)
  return list
}

// the emulator screenshots shipped with this deploy (npm run shots writes public/shots/index.json)
let SHOTS = null
async function shots(env) {
  if (!SHOTS) {
    try {
      const r = await env.ASSETS.fetch(new Request('https://assets.local/shots/index.json'))
      SHOTS = r.ok ? await r.json() : {}
    } catch {
      SHOTS = {}
    }
  }
  return SHOTS
}
const withShots = async (env, list) => {
  const index = await shots(env)
  for (const row of list) {
    row.shot = index[row.id]?.v
    // a screenshot that failed: why, and which listed file it was (its notes on the site depend on it)
    if (index[row.id]?.failed) row.shotFailed = { reason: index[row.id].failed, sha256: index[row.id].sha256 }
  }
  return list
}

async function rows(env) {
  const [entries, latest, newest] = await env.DB.batch([env.DB.prepare('SELECT id, repo, auto, data, hidden, locked, created_by, created, updated, synced FROM entries'), env.DB.prepare(LATEST), env.DB.prepare(NEWEST)])
  return withShots(env, attachLatest(entries.results, latest.results, newest.results))
}

// both lists are built from the same rows and cached together; ETags let devices (fm1buddy) skip unchanged lists
const LISTS = ['/firmware.json', '/catalog.json']

async function sha1(text) {
  const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function cachedJson(body) {
  const text = JSON.stringify(body, null, 1)
  return new Response(text, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-expose-headers': 'etag',
      'cache-control': `public, max-age=${LIST_TTL}`,
      'x-built': String(Date.now()),
      etag: `"${await sha1(text)}"`
    }
  })
}

async function buildLists(env, origin) {
  const raw = await rows(env)
  const synced = raw.reduce((m, r) => (r.synced && r.synced > m ? r.synced : m), '') || new Date().toISOString()
  // pictures as whole URLs, so other apps can show them too
  const abs = (u) => (u && u.startsWith('/') ? origin + u : u)
  const all = raw
    .map(effective)
    .filter((e) => !e.hidden)
    .map((e) => ({ ...e, cover: abs(e.cover), screen: abs(e.screen) }))
  all.sort((a, b) => (b.updated || '').localeCompare(a.updated || '') || a.name.localeCompare(b.name))
  return {
    '/firmware.json': {
      about: 'Every firmware and tool for the M-VAVE FM1, SMK-37 and friends. Self-serve: sign in with GitHub at https://mutant.cloud to add or edit. /catalog.json has the same firmwares in The Firmware Hub format, one row per installable package.',
      updated: synced,
      count: all.length,
      devices: DEVICES,
      kinds: KINDS,
      tags: TAGS,
      bases: BASE_INFO,
      entries: all
    },
    '/catalog.json': catalog(all, synced)
  }
}

async function listResponse(request, env, ctx, url) {
  const cache = caches.default
  const path = url.pathname === '/api/entries' ? '/firmware.json' : url.pathname
  // no list cache on the local server (npm run start sets LOCAL), so it always shows the remote database as it is.
  // (wrangler dev rewrites the host to mutant.cloud, so the URL can't tell us.)
  const local = !!env.LOCAL
  // filters (?device=fm1&author=konsumer…): the same ones the site's links use
  const filter = {}
  for (const k of FILTERS) {
    const v = url.searchParams.get(k)
    if (v) filter[k] = v.slice(0, 100)
  }
  const filtered = Object.keys(filter).length > 0
  // a filtered list is cut from the whole firmware.json, so get that one when filtering
  const base = filtered ? '/firmware.json' : path
  let res = local ? null : await cache.match(listKey(url.origin, base, env))
  // the zone's cache settings can stretch a cached copy's lifetime (Browser Cache TTL: 4 h by default),
  // so the worker keeps its own clock on the list
  if (res && Date.now() - Number(res.headers.get('x-built') || 0) > LIST_TTL * 1000) res = null
  if (!res) {
    const lists = await buildLists(env, url.origin)
    for (const p of LISTS) {
      const r = await cachedJson(lists[p])
      if (p === base) res = r.clone()
      if (!local) ctx.waitUntil(cache.put(listKey(url.origin, p, env), r))
    }
  }
  if (filtered) {
    const whole = await res.json()
    const entries = whole.entries.filter((e) => matches(e, filter))
    if (path === '/catalog.json') {
      const cat = catalog(entries, whole.updated)
      // per package: ?device=smk37 keeps only SMK-37 builds, not a firmware's FM1 ones too; ?deviceId= only that ID
      if (filter.device && filter.device !== 'all') {
        cat.firmwares = cat.firmwares.filter((r) => r.devices.includes(filter.device))
        if (cat.stock && deviceOf(cat.stock.product) !== filter.device) cat.stock = null
      }
      if (filter.deviceId) {
        const id = parseDeviceId(filter.deviceId)
        cat.firmwares = cat.firmwares.filter((r) => r.product === id)
        if (cat.stock && cat.stock.product !== id) cat.stock = null
      }
      cat.count = cat.firmwares.length
      res = await cachedJson({ ...cat, filter })
    } else {
      res = await cachedJson({ ...whole, filter, count: entries.length, entries })
    }
  }
  if (local) {
    // never let the local dev cache keep a list either
    res = new Response(res.body, res)
    res.headers.set('cache-control', 'no-store')
  }
  const etag = res.headers.get('etag')
  if (etag && request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { etag, 'access-control-allow-origin': '*', 'cache-control': res.headers.get('cache-control') } })
  }
  return res
}

// cached lists are keyed by the deployed version, so a deploy never serves a list the old code made
const listKey = (origin, path, env) => new Request(`${origin}${path}?v=${env.CF_VERSION_METADATA?.id || 'dev'}`)
const purge = (request, env) => Promise.all(LISTS.map((p) => caches.default.delete(listKey(new URL(request.url).origin, p, env))))

// --- the site's own page: the list inlined in its HTML -----------------------
// One response carries the page, its scripts and the records, so the first load needs no second request (and no
// extra round trip) for /firmware.json: the front end reads <script id="fw"> instead of fetching it. A listing's
// own page isn't inlined (its preview tags are what gets fetched there), so it takes the list from the API.

async function homePage(request, env, ctx, url) {
  const fw = new URL('/firmware.json', url.origin)
  const [page, list] = await Promise.all([env.ASSETS.fetch(new Request(`${url.origin}/`)), listResponse(new Request(fw), env, ctx, fw)])
  // a description could contain "</script>": the JSON escape keeps it inside the element (and reads the same)
  const body = (await list.text()).replace(/<\//g, '<\\/')
  return new HTMLRewriter().on('body', { element: (el) => el.append(`<script type="application/json" id="fw">${body}</script>`, { html: true }) }).transform(
    new Response(page.body, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': env.LOCAL ? 'no-store' : `public, max-age=${LIST_TTL}`
      }
    })
  )
}

// --- /sitemap.xml: every listing's own page (what search engines crawl) ------

async function sitemap(request, env, ctx, url) {
  const fw = new URL('/firmware.json', url.origin)
  const list = await (await listResponse(new Request(fw), env, ctx, fw)).json()
  const rows = [{ loc: `${url.origin}/` }, { loc: `${url.origin}/feed.xml` }, ...list.entries.map((e) => ({ loc: `${url.origin}/${e.id}`, lastmod: e.updated }))]
  const body = `<?xml version="1.0" encoding="utf-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${rows.map((r) => `  <url><loc>${r.loc}</loc>${r.lastmod ? `<lastmod>${r.lastmod.slice(0, 10)}</lastmod>` : ''}</url>`).join('\n')}
</urlset>
`
  return new Response(body, { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': env.LOCAL ? 'no-store' : `public, max-age=${LIST_TTL}` } })
}

// --- /feed.xml: RSS 2.0 of new listings and versions --------------------------
// A timeline: one item per version (pre-releases too) and per new listing, newest first. Same filters as
// /firmware.json; kind defaults to firmware (?kind=all for tools too).

const FEED_SIZE = 50
const xml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c])
const rfc822 = (iso) => {
  const d = new Date(iso)
  return isNaN(d) ? null : d.toUTCString()
}

async function feed(request, env, ctx, url) {
  const u = new URL(url)
  u.pathname = '/firmware.json'
  if (!u.searchParams.get('kind')) u.searchParams.set('kind', 'firmware')
  const list = await (await listResponse(new Request(u), env, ctx, u)).json()

  // the timeline: every version of every matching listing, newest first. A listing's first version is its
  // arrival; a listing with no versions yet arrives on the day it was added.
  const by = new Map(list.entries.map((e) => [e.id, e]))
  const { results } = await env.DB.prepare(`SELECT * FROM (SELECT entry, version, COALESCE(date, added) AS date, url, prerelease, assets, added AS seen, ROW_NUMBER() OVER (PARTITION BY entry ORDER BY COALESCE(date, added), added) = 1 AS first FROM releases WHERE source <> 'removed') ORDER BY date DESC, seen DESC`).all()
  const items = []
  const seen = new Set()
  for (const r of results) {
    const e = by.get(r.entry)
    if (!e) continue
    seen.add(e.id)
    items.push({ e, rel: parseRel(r), date: r.date, seen: r.seen, first: !!r.first })
  }
  for (const e of list.entries) if (!seen.has(e.id) && !e.latest?.count && e.added) items.push({ e, date: e.added, seen: e.added, first: true })
  // (same-day versions: the one this hub saw last first)
  items.sort((a, b) => b.date.localeCompare(a.date) || (b.seen || '').localeCompare(a.seen || ''))

  const self = `${url.origin}${url.pathname}${url.search}`
  const filters = Object.entries(list.filter || {})
    .filter(([k]) => k !== 'kind')
    .map(([k, v]) => `${k}: ${v}`)
  const what = list.filter?.kind === 'tool' ? 'tools' : list.filter?.kind === 'all' ? 'firmware and tools' : 'firmware'
  const title = `mutant.cloud · new ${what}${filters.length ? ` (${filters.join(', ')})` : ''}`
  // the same list on the site (which opens on FM1 firmware, so say "all devices" when no device was asked for)
  const sp = new URLSearchParams(list.filter)
  if (!sp.has('device')) sp.set('device', 'all')
  if (sp.get('kind') === 'firmware') sp.delete('kind')
  const site = `${url.origin}/?${sp}`

  const item = ({ e, rel, date, first }) => {
    const link = `${url.origin}/${e.id}`
    const devices = e.devices.map((d) => DEVICES[d] || d).join(' & ')
    const pkg = pkgs(rel)[0]
    const image = e.cover
    const body = [image ? `<p><img src="${xml(image)}" alt="${xml(e.name)}" /></p>` : '', `<p>${xml(e.description || `${e.kind === 'tool' ? 'A tool' : 'Firmware'} for the ${devices}.`)}</p>`, `<p>${first ? 'New listing · ' : ''}By ${xml(e.author)}${devices ? ` · ${xml(devices)}` : ''}${rel?.prerelease ? ' · pre-release' : ''}</p>`, rel?.url ? `<p><a href="${xml(rel.url)}">Release notes</a></p>` : ''].join('')
    return ['<item>', `<title>${xml(`${first ? 'New: ' : ''}${e.name}${rel ? ` ${rel.version}` : ''}`)}</title>`, `<link>${xml(link)}</link>`, `<guid isPermaLink="false">${xml(`${url.host}/${e.id}${rel ? `@${rel.version}` : ''}`)}</guid>`, rfc822(date) ? `<pubDate>${rfc822(date)}</pubDate>` : '', `<dc:creator>${xml(e.author)}</dc:creator>`, ...e.tags.map((t) => `<category>${xml(t)}</category>`), `<description>${xml(body)}</description>`, pkg ? `<enclosure url="${xml(pkg.url)}" length="${pkg.size}" type="application/octet-stream" />` : '', '</item>'].filter(Boolean).join('\n      ')
  }

  const text = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>${xml(title)}</title>
    <link>${xml(site)}</link>
    <description>New versions of firmware and tools for the M-VAVE FM1, SMK-37 and friends.</description>
    <language>en</language>
    <atom:link href="${xml(self)}" rel="self" type="application/rss+xml" />
    <lastBuildDate>${rfc822(list.updated) || new Date().toUTCString()}</lastBuildDate>
    <ttl>${LIST_TTL / 60}</ttl>
    <image>
      <url>${url.origin}/og.png</url>
      <title>${xml(title)}</title>
      <link>${xml(site)}</link>
    </image>
    ${items.slice(0, FEED_SIZE).map(item).join('\n    ')}
  </channel>
</rss>
`
  const etag = `"${await sha1(text)}"`
  const headers = {
    'content-type': 'application/rss+xml; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'etag',
    'cache-control': env.LOCAL ? 'no-store' : `public, max-age=${LIST_TTL}`,
    etag
  }
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers })
  return new Response(text, { headers })
}

// --- /catalog.json: The Firmware Hub's format (what fm1buddy reads) ------
// One row per installable package of each firmware's latest release: pkg is a whole URL (the maker's own
// release file, never a copy), with the sha256, size and product checked from the file itself.

const HUB_KIND = { groovebox: 'groove', synth: 'synth', drums: 'drums', chords: 'chords', tracker: 'tracker' }
// (a file the checks found gone or not a package isn't offered: the listing stays, as links only)
const pkgs = (r) => (r?.assets || []).filter((a) => a.sha256 && a.product && a.size && !a.missing && !a.invalid && /^https:\/\//.test(a.url))
const hubTime = (iso) => iso.slice(0, 16).replace('T', ' ') + ' UTC'

function variantOf(file, e) {
  let v = file.replace(/\.fwsc$/i, '').replace(/[-_ ]v?\d+(\.\d+)*([-.][0-9a-z.]+)?$/i, '')
  const lower = v.toLowerCase()
  for (const prefix of [e.id, slugify(e.name), e.repo?.split('/')[1]?.toLowerCase()].filter(Boolean)) {
    if (lower.startsWith(prefix)) {
      v = v.slice(prefix.length)
      break
    }
  }
  return v.replace(/^[-_ ]+/, '')
}

function catalog(all, synced) {
  const firmwares = []
  let stock = null
  const ids = new Set()
  for (const e of all) {
    if (e.kind !== 'firmware') continue
    const rel = pkgs(e.release).length ? e.release : pkgs(e.prerelease).length ? e.prerelease : null
    if (!rel) continue
    const list = pkgs(rel)
    const kinds = [...new Set(e.tags.map((t) => HUB_KIND[t]).filter(Boolean))] // (e.tags starts with the main tag)
    const play = e.links.find((l) => /try|play|emulator|browser/i.test(l.label))?.url
    const editor = e.links.find((l) => /editor/i.test(l.label))?.url
    for (const a of list) {
      if (e.stock && deviceOf(a.product) === 'fm1' && !stock) {
        stock = { pkg: a.url, file: a.name, sha256: a.sha256, size: a.size, product: a.product, source: a.url }
        continue
      }
      const variant = list.length > 1 ? variantOf(a.name, e) : ''
      let id = variant ? `${e.id}-${slugify(variant)}` : e.id
      if (ids.has(id)) id = `${e.id}-${slugify(a.product)}`
      if (ids.has(id)) continue
      ids.add(id)
      firmwares.push({
        id,
        entry: e.id,
        kind: kinds.length === 1 ? kinds[0] : kinds.length ? kinds : 'other',
        tags: e.tags,
        primaryTag: e.primaryTag || null,
        name: variant ? `${e.name} (${variant})` : e.name,
        author: e.author,
        repo: e.repo || null,
        what: e.description || '',
        editor: editor || null,
        play: play || null,
        site: e.homepage || null,
        lic: e.license || null,
        version: String(rel.version || '').replace(/^v(?=\d)/, ''),
        date: rel.date || null,
        release: rel.url || null,
        pkg: a.url,
        file: a.name,
        product: a.product,
        size: a.size,
        sha256: a.sha256,
        // the flash chip it knows, as The Firmware Hub says it: new, old (the first FM-1s only) or any (it doesn't check)
        chip: ['new', 'old', 'any'].includes(a.chip) ? a.chip : undefined,
        beta: !!(e.beta || rel.prerelease),
        stock: e.stock || undefined,
        hid: e.hid || { keyboard: false, mouse: false },
        devices: [deviceOf(a.product)].filter(Boolean),
        added: e.added || null,
        updated: e.updated || null,
        versions: e.versions || 1,
        source: e.repo ? `https://github.com/${e.repo}` : e.homepage || null,
        image: e.cover || null
      })
    }
  }
  return { updated: hubTime(synced), hub: 'https://mutant.cloud', count: firmwares.length, firmwares, stock }
}

async function loadRow(env, id) {
  const row = await env.DB.prepare('SELECT * FROM entries WHERE id = ?').bind(id).first()
  if (!row) throw new HttpError(404, 'no such entry')
  const [latest, newest] = await env.DB.batch([env.DB.prepare(`SELECT * FROM (${LATEST}) WHERE entry = ?`).bind(id), env.DB.prepare(`SELECT * FROM (${NEWEST}) WHERE entry = ?`).bind(id)])
  return (await withShots(env, attachLatest([row], latest.results, newest.results)))[0]
}

async function versions(env, id) {
  const { results } = await env.DB.prepare(`SELECT version, date, url, prerelease, assets, source FROM releases WHERE entry = ? AND source <> 'removed' ORDER BY date DESC, (assets LIKE '%"sha256"%') DESC, added DESC`).bind(id).all()
  return results.map((r) => ({ ...parseRel(r), source: r.source }))
}

// one entry, with its whole version history
async function getOne(env, id) {
  const e = effective(await loadRow(env, id))
  if (e.hidden) throw new HttpError(404, 'no such entry')
  e.history = await versions(env, id)
  return json(e)
}

// --- downloads ------------------------------------------------------------

const DL_MAX = 16 * 1024 * 1024

// /dl/<id>/<file>: a package one of the listing's versions names, fetched from the maker's link and served with
// CORS on, so emulators and installers in the browser can load it (GitHub's release downloads have no CORS).
// Only listed files are served, so it is not an open proxy. Cached at the edge by its address.
async function download(request, env, ctx, id, file) {
  const url = new URL(request.url)
  const key = new Request(`${url.origin}/dl/${id}/${encodeURIComponent(file)}`)
  const cache = caches.default
  let res = await cache.match(key)
  if (!res) {
    const row = await env.DB.prepare('SELECT hidden FROM entries WHERE id = ?').bind(id).first()
    if (!row || row.hidden) throw new HttpError(404, 'no such entry')
    const { results } = await env.DB.prepare(`SELECT assets FROM releases WHERE entry = ? AND source <> 'removed' ORDER BY date DESC, added DESC`).bind(id).all()
    const asset = results.flatMap((r) => JSON.parse(r.assets || '[]')).find((a) => a.name === file && a.url)
    if (!asset) throw new HttpError(404, 'no such file')
    const up = await fetch(asset.url, { redirect: 'follow', headers: { 'user-agent': 'mutant.cloud' } })
    if (!up.ok) throw new HttpError(502, `the maker's link answered ${up.status}`)
    if (Number(up.headers.get('content-length') || 0) > DL_MAX) throw new HttpError(413, 'file too large')
    const bytes = await up.arrayBuffer()
    if (bytes.byteLength > DL_MAX) throw new HttpError(413, 'file too large')
    res = new Response(bytes, {
      headers: {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${file.replace(/["\\]/g, '')}"`,
        'cache-control': 'public, max-age=3600, s-maxage=86400',
        'access-control-allow-origin': '*'
      }
    })
    ctx.waitUntil(cache.put(key, res.clone()))
  }
  return request.method === 'HEAD' ? new Response(null, { headers: res.headers }) : res
}

// --- auth -----------------------------------------------------------------

function cookies(request) {
  const out = {}
  for (const part of (request.headers.get('cookie') || '').split(/;\s*/)) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1))
  }
  return out
}

// Secure everywhere but the local server (some browsers refuse Secure cookies on http://localhost)
const setCookie = (name, value, maxAge, env) => `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly;${env?.LOCAL ? '' : ' Secure;'} SameSite=Lax; Max-Age=${maxAge}`

const randomId = () => [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('')

async function session(request, env) {
  const sid = cookies(request)[SESSION_COOKIE]
  if (!sid || !/^[a-f0-9]{48}$/.test(sid)) return null
  return env.SESSIONS.get(`s:${sid}`, 'json')
}

async function requireUser(request, env) {
  const user = await session(request, env)
  if (!user) throw new HttpError(401, 'sign in with GitHub first')
  return user
}

function login(request, env, url) {
  if (!env.GITHUB_CLIENT_ID) throw new HttpError(500, 'GitHub login is not set up (GITHUB_CLIENT_ID)')
  const state = randomId()
  const next = url.searchParams.get('next') || '/'
  const gh = new URL('https://github.com/login/oauth/authorize')
  gh.searchParams.set('client_id', env.GITHUB_CLIENT_ID)
  gh.searchParams.set('redirect_uri', `${url.origin}/auth/callback`)
  gh.searchParams.set('state', state)
  gh.searchParams.set('allow_signup', 'true')
  return new Response(null, {
    status: 302,
    headers: { location: gh.toString(), 'set-cookie': setCookie(STATE_COOKIE, `${state}|${next.startsWith('/') ? next : '/'}`, 600, env) }
  })
}

const ghHeaders = (token) => ({
  accept: 'application/vnd.github+json',
  'user-agent': 'mutant.cloud',
  'x-github-api-version': '2022-11-28',
  ...(token ? { authorization: `Bearer ${token}` } : {})
})

async function ghGet(path, token) {
  const r = await fetch(`https://api.github.com${path}`, { headers: ghHeaders(token) })
  if (r.status === 404) return null
  if (r.status === 401 && token) throw new HttpError(401, 'your GitHub sign-in has expired: sign out and sign in again', { relogin: true })
  if (!r.ok) throw new HttpError(502, `GitHub said ${r.status}`)
  return r.json()
}

// public repos the person can push to (their own, collaborator, org member)
async function pushableRepos(token) {
  const out = []
  for (let page = 1; page <= 5; page++) {
    const list = await ghGet(`/user/repos?per_page=100&page=${page}&affiliation=owner,collaborator,organization_member`, token)
    if (!list?.length) break
    for (const r of list) if (r.permissions?.push) out.push(r.full_name.toLowerCase())
    if (list.length < 100) break
  }
  return out
}

async function callback(request, env, url) {
  const [state, next] = (cookies(request)[STATE_COOKIE] || '').split('|')
  if (!state || state !== url.searchParams.get('state')) throw new HttpError(400, 'login expired, try again')
  const r = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'mutant.cloud' },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code: url.searchParams.get('code'),
      redirect_uri: `${url.origin}/auth/callback`
    })
  })
  const tok = await r.json()
  if (!tok.access_token) throw new HttpError(400, 'GitHub login failed')
  const gh = await ghGet('/user', tok.access_token)
  const user = {
    login: gh.login,
    id: gh.id,
    name: gh.name || gh.login,
    avatar: gh.avatar_url,
    token: tok.access_token,
    repos: await pushableRepos(tok.access_token).catch(() => []),
    at: new Date().toISOString()
  }
  const sid = randomId()
  await env.SESSIONS.put(`s:${sid}`, JSON.stringify(user), { expirationTtl: SESSION_TTL })
  // sign-ins go in the audit log too (no listing), so admins can see who's active
  await audit(env, '', gh.login, 'login')
  const headers = new Headers({ location: next || '/' })
  headers.append('set-cookie', setCookie(SESSION_COOKIE, sid, SESSION_TTL, env))
  headers.append('set-cookie', setCookie(STATE_COOKIE, '', 0, env))
  return new Response(null, { status: 302, headers })
}

async function logout(request, env) {
  const sid = cookies(request)[SESSION_COOKIE]
  if (sid) await env.SESSIONS.delete(`s:${sid}`)
  return json({ ok: true }, 200, { 'set-cookie': setCookie(SESSION_COOKIE, '', 0, env) })
}

// how often a session re-checks its GitHub token (and the repos it can push to)
const RECHECK = 60 * 60 * 1000

async function me(request, env) {
  const user = await session(request, env)
  if (!user) return json({ user: null })
  if (!(Date.parse(user.checked || user.at) > Date.now() - RECHECK)) {
    const sid = cookies(request)[SESSION_COOKIE]
    try {
      user.repos = await pushableRepos(user.token)
      user.checked = new Date().toISOString()
      await env.SESSIONS.put(`s:${sid}`, JSON.stringify(user), { expirationTtl: SESSION_TTL })
    } catch (err) {
      // GitHub dropped the token: end the session so the page signs in again (GitHub skips the prompt if already approved)
      if (err.extra?.relogin) {
        await env.SESSIONS.delete(`s:${sid}`)
        return json({ user: null, relogin: true }, 200, { 'set-cookie': setCookie(SESSION_COOKIE, '', 0, env) })
      }
    }
  }
  const admin = admins(env).some((a) => a.toLowerCase() === user.login.toLowerCase())
  // "mine" never includes everything just because you're an admin
  const manages = (await rows(env)).map(effective).filter((e) => canManage({ ...e, locked: false }, user, []))
  manages.sort((a, b) => a.name.localeCompare(b.name))
  return json({ user: { login: user.login, name: user.name, avatar: user.avatar, admin }, manages })
}

// --- GitHub repo info (same shape the collector writes) --------------------

const FIRMWARE_FILE = /\.(fwsc|syx|bin|hex|uf2|zip)$/i
const SOURCE_FILE = /(source|src)[^/]*\.(zip|tar\.gz)$|\.tar\.gz$/i

const relOf = (r) =>
  r && {
    version: r.tag_name,
    date: (r.published_at || '').slice(0, 10),
    url: r.html_url,
    prerelease: r.prerelease || undefined,
    assets: (r.assets || [])
      .filter((a) => FIRMWARE_FILE.test(a.name) && !SOURCE_FILE.test(a.name))
      .sort((a, b) => /\.fwsc$/i.test(b.name) - /\.fwsc$/i.test(a.name))
      .slice(0, 12)
      .map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size, _digest: a.digest || undefined }))
  }

// check the .fwsc files of the given releases (sha256, size, product); results go on matching assets in `also` too.
// A file that isn't a package is marked `invalid`, one that couldn't be downloaded `unchecked` (both with the
// date): the site shows a "might not install" note, and the watcher's re-check tries them again.
async function checkAssets(rels, also = []) {
  const today = new Date().toISOString().slice(0, 10)
  const found = new Map()
  const todo = rels
    .filter(Boolean)
    .flatMap((r) => r.assets || [])
    .filter((a) => /\.fwsc$/i.test(a.name) && !a.sha256)
    .slice(0, 12)
  await Promise.all(
    todo.map(async (a) => {
      try {
        const c = await inspect(a.url, { digest: a._digest, headers: { 'user-agent': 'mutant.cloud' } })
        found.set(a.url, c ? { ...c, checked: today } : { invalid: today, checked: today })
      } catch {
        found.set(a.url, { unchecked: today })
      }
    })
  )
  for (const r of [...rels, ...also].filter(Boolean)) {
    for (const a of r.assets || []) {
      delete a._digest
      const c = found.get(a.url)
      if (!c) continue
      if (c.sha256) {
        delete a.invalid
        delete a.unchecked
      }
      Object.assign(a, c)
    }
  }
}

async function repoInfo(repo, token) {
  // a dead sign-in token (revoked, or pushed out by newer sign-ins) can still read public repos without it
  let stale = false
  let r
  try {
    r = await ghGet(`/repos/${repo}`, token)
  } catch (err) {
    if (!err.extra?.relogin) throw err
    stale = true
    token = undefined
    r = await ghGet(`/repos/${repo}`)
  }
  if (!r) return null
  if (r.private) return { private: true }
  const releases = ((await ghGet(`/repos/${repo}/releases?per_page=100`, token)) || []).filter((x) => !x.draft)
  const latest = releases.find((x) => !x.prerelease)
  const newest = releases[0]
  const out = {
    repo: r.full_name,
    description: r.description || undefined,
    homepage: cleanUrl(r.homepage) || undefined,
    license: r.license?.spdx_id && r.license.spdx_id !== 'NOASSERTION' ? r.license.spdx_id : undefined,
    author: r.owner.login,
    base: baseOfRepo(r.template_repository?.full_name, r.parent?.full_name) || undefined,
    archived: r.archived || undefined,
    added: r.created_at.slice(0, 10),
    updated: [r.pushed_at, latest?.published_at].filter(Boolean).sort().pop().slice(0, 10),
    release: relOf(latest || newest) || undefined,
    prerelease: latest && newest?.prerelease && newest.published_at > latest.published_at ? relOf(newest) : undefined
  }
  const all = releases.map(relOf)
  await checkAssets([out.release, out.prerelease], all)
  // devices learned from the packages themselves
  const devs = [...(out.release?.assets || []), ...(out.prerelease?.assets || [])].map((a) => deviceOf(a.product)).filter(Boolean)
  if (devs.length) out.devices = [...new Set(devs)]
  // canPush: what GitHub says the token's owner may do with this repo (owner, collaborator, org member)
  return { info: JSON.parse(JSON.stringify(out)), all, stale, canPush: !!(r.permissions?.push || r.permissions?.admin) }
}

// --- write endpoints ------------------------------------------------------

async function audit(env, entry, login, action, change) {
  await env.DB.prepare('INSERT INTO audit (entry, login, action, change, at) VALUES (?, ?, ?, ?, ?)')
    .bind(entry, login, action, change ? JSON.stringify(change) : null, new Date().toISOString())
    .run()
}

async function body(request) {
  const len = Number(request.headers.get('content-length') || 0)
  if (len > 32 * 1024) throw new HttpError(413, 'too big')
  try {
    return await request.json()
  } catch {
    throw new HttpError(400, 'send JSON')
  }
}

async function repoTaken(env, repo, exceptId) {
  const row = await env.DB.prepare('SELECT id FROM entries WHERE repo = ?').bind(repoKey(repo)).first()
  return row && row.id !== exceptId ? row.id : null
}

async function freeId(env, name) {
  const base = RESERVED.has(slugify(name)) ? `${slugify(name)}-fw` : slugify(name)
  for (let n = 1; n < 100; n++) {
    const id = n === 1 ? base : `${base}-${n}`
    if (!(await env.DB.prepare('SELECT 1 FROM entries WHERE id = ?').bind(id).first())) return id
  }
  throw new HttpError(409, 'pick a different name')
}

async function create(request, env, ctx) {
  const user = await requireUser(request, env)
  const input = await body(request)
  const { data, errors } = cleanInput(input)
  if (errors.length) throw new HttpError(400, errors.join(', '), { errors })
  const admin = isAdmin(user, admins(env))
  if (!admin && input.confirm !== true) throw new HttpError(400, "confirm that you made this firmware (or have its maker's permission to list it)")

  const dayKey = `rl:${user.login}:${new Date().toISOString().slice(0, 10)}`
  const count = Number((await env.SESSIONS.get(dayKey)) || 0)
  if (count >= CREATE_LIMIT) throw new HttpError(429, 'that is a lot of new entries today, try again tomorrow')

  let auto = {}
  let gh = null
  if (data.repo) {
    const taken = await repoTaken(env, data.repo)
    if (taken) throw new HttpError(409, 'that repo is already listed', { id: taken })
    gh = await repoInfo(data.repo, user.token)
    if (!gh) throw new HttpError(400, 'could not find that repo on GitHub (it must be public)')
    if (gh.private) throw new HttpError(400, 'that repo is private: only public repos can be listed')
    // listing a repo means managing it: only people who can push to it (GitHub decides, checked right now)
    // admins can list anyone's repo (the owner can take it over by signing in)
    if (!admin && gh.stale) throw new HttpError(401, 'your GitHub sign-in has expired: sign out and sign in again')
    if (!admin && !gh.canPush) {
      throw new HttpError(403, `you can only list repos you own or can push to, and GitHub says you can't push to ${gh.info.repo}. If it's yours from another account, sign in with that one; if it's someone else's, ask them to list it.`)
    }
    auto = { ...gh.info, sources: ['user'] }
    data.repo = auto.repo
  }
  // whoever adds it can manage it (repo owners always can, so they need no entry)
  const isOwner = data.repo && repoOwner(data.repo).toLowerCase() === user.login.toLowerCase()
  if (!isOwner && !(data.managers || []).some((m) => m.toLowerCase() === user.login.toLowerCase())) {
    data.managers = [user.login, ...(data.managers || [])]
  }
  const id = await freeId(env, data.name)
  const now = new Date().toISOString()
  await env.DB.prepare('INSERT INTO entries (id, repo, auto, data, created_by, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, repoKey(data.repo), JSON.stringify(auto), JSON.stringify(data), user.login, now, now).run()
  if (gh) await saveVersions(env, id, gh.all, 'github')
  await env.SESSIONS.put(dayKey, String(count + 1), { expirationTtl: 60 * 60 * 26 })
  await audit(env, id, user.login, 'create', data)
  await purge(request, env)
  return json(effective(await loadRow(env, id)), 201)
}

async function editable(request, env, id) {
  const user = await requireUser(request, env)
  const row = await loadRow(env, id)
  const e = effective(row)
  if (!canManage(e, user, admins(env))) {
    throw new HttpError(403, e.locked ? `${e.name} is locked by the admins, so it can't be changed right now. Open an issue at github.com/konsumer/mutantcloud if that's a mistake.` : `you can't manage ${e.name}. Repo owners and listed managers can.`)
  }
  return { user, row, e }
}

async function edit(request, env, ctx, id) {
  const { user, row } = await editable(request, env, id)
  const input = await body(request)
  const { data: patch, errors } = cleanInput(input, { partial: true })
  if (errors.length) throw new HttpError(400, errors.join(', '), { errors })

  const admin = isAdmin(user, admins(env))
  const old = JSON.parse(row.data || '{}')
  let repo = row.repo
  // the repo a listing points at can't be changed by its managers (that would let anyone take over or
  // misrepresent a project). GitHub renames and transfers are followed by the sync; anything else is an admin's job.
  if ('repo' in patch && repoKey(patch.repo) !== row.repo && !admin) {
    throw new HttpError(403, "a listing's GitHub repo can't be changed. Renames and transfers on GitHub are followed automatically; for anything else, ask an admin (open an issue at github.com/konsumer/mutantcloud).")
  }
  if (!admin) delete patch.repo
  const next = { ...old, ...patch }
  if ('repo' in patch && repoKey(patch.repo) !== row.repo) {
    if (patch.repo) {
      const taken = await repoTaken(env, patch.repo, id)
      if (taken) throw new HttpError(409, 'that repo is already listed', { id: taken })
      if (!(await ghGet(`/repos/${patch.repo}`, user.token).catch((err) => (err.extra?.relogin ? ghGet(`/repos/${patch.repo}`) : Promise.reject(err))))) throw new HttpError(400, 'could not find that repo on GitHub')
    }
    repo = repoKey(patch.repo)
  }
  // a main tag must be one of the tags (setting tags without it drops a main tag that's gone)
  if (next.primaryTag && next.tags && !next.tags.includes(next.primaryTag)) delete next.primaryTag

  let hidden = row.hidden
  if ('hidden' in input) hidden = input.hidden ? 1 : 0
  let locked = row.locked || 0
  if ('locked' in input) {
    if (!admin) throw new HttpError(403, 'only admins can lock or unlock a listing')
    locked = input.locked ? 1 : 0
  }

  await env.DB.prepare('UPDATE entries SET data = ?, repo = ?, hidden = ?, locked = ?, updated = ? WHERE id = ?').bind(JSON.stringify(next), repo, hidden, locked, new Date().toISOString(), id).run()
  await audit(env, id, user.login, 'locked' in input ? (locked ? 'lock' : 'unlock') : 'edit', { ...patch, ...('hidden' in input ? { hidden: !!hidden } : {}), ...('locked' in input ? { locked: !!locked } : {}) })
  await purge(request, env)
  return json(effective(await loadRow(env, id)))
}

// entries only people added are removed; collected ones are hidden (or the next sync re-adds them)
async function remove(request, env, ctx, id) {
  const { user, row } = await editable(request, env, id)
  const collected = row.synced || (JSON.parse(row.auto || '{}').sources || []).some((s) => s !== 'user')
  if (collected) {
    await env.DB.prepare('UPDATE entries SET hidden = 1, updated = ? WHERE id = ?').bind(new Date().toISOString(), id).run()
  } else {
    await env.DB.batch([env.DB.prepare('DELETE FROM entries WHERE id = ?').bind(id), env.DB.prepare('DELETE FROM releases WHERE entry = ?').bind(id)])
  }
  await audit(env, id, user.login, collected ? 'hide' : 'delete')
  await purge(request, env)
  return json({ ok: true, hidden: !!collected, deleted: !collected })
}

async function refresh(request, env, ctx, id) {
  const { user, row, e } = await editable(request, env, id)
  if (!e.repo) throw new HttpError(400, 'nothing to refresh without a GitHub repo')
  const gh = await repoInfo(e.repo, user.token)
  if (!gh) throw new HttpError(400, 'GitHub cannot find that repo any more')
  const auto = { ...JSON.parse(row.auto || '{}'), ...gh.info }
  await saveVersions(env, id, gh.all, 'github')
  await env.DB.prepare('UPDATE entries SET auto = ?, updated = ? WHERE id = ?').bind(JSON.stringify(auto), new Date().toISOString(), id).run()
  await purge(request, env)
  return json(effective(await loadRow(env, id)))
}

async function history(request, env, id) {
  await editable(request, env, id)
  const { results } = await env.DB.prepare('SELECT login, action, change, at FROM audit WHERE entry = ? ORDER BY n DESC LIMIT 50').bind(id).all()
  return json(results.map((r) => ({ ...r, change: r.change ? JSON.parse(r.change) : null })))
}

// --- version history ------------------------------------------------------

// add or update versions; hand-added (manual/action) ones only change through their own path
async function saveVersions(env, id, list, source) {
  const now = new Date().toISOString()
  const keep = source === 'github' ? "WHERE releases.source NOT IN ('manual', 'action', 'removed')" : ''
  const stmts = list
    .filter((v) => v?.version)
    .map((v) =>
      env.DB.prepare(
        `INSERT INTO releases (entry, version, date, url, prerelease, assets, notes, source, added) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(entry, version) DO UPDATE SET date = COALESCE(excluded.date, releases.date), url = COALESCE(excluded.url, releases.url), prerelease = excluded.prerelease,
        assets = CASE WHEN excluded.assets = '[]' THEN releases.assets ELSE excluded.assets END, notes = COALESCE(excluded.notes, releases.notes), source = excluded.source ${keep}`
      ).bind(id, String(v.version).slice(0, 80), v.date || null, v.url || null, v.prerelease ? 1 : 0, JSON.stringify(v.assets || []), v.notes || null, source, now)
    )
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50))
}

function cleanVersion(b) {
  const version = String(b?.version || '')
    .trim()
    .slice(0, 80)
  if (!version) throw new HttpError(400, 'version is required')
  const date = /^\d{4}-\d{2}-\d{2}/.test(b.date || '') ? b.date.slice(0, 10) : new Date().toISOString().slice(0, 10)
  const assets = (Array.isArray(b.assets) ? b.assets : [])
    .map((a) => ({
      name:
        String(a?.name || '')
          .trim()
          .slice(0, 120) || (cleanUrl(a?.url) || '').split('/').pop(),
      url: cleanUrl(a?.url),
      size: Number(a?.size) || undefined
    }))
    .filter((a) => a.url && a.name)
    .slice(0, 20)
  const url = cleanUrl(b.url)
  if (!url && !assets.length) throw new HttpError(400, 'give a release page URL or at least one file URL')
  return { version, date, url, prerelease: !!b.prerelease, assets, notes: b.notes ? String(b.notes).slice(0, 2000) : null }
}

async function addVersion(request, env, id) {
  const { user } = await editable(request, env, id)
  const v = cleanVersion(await body(request))
  await checkAssets([v])
  await saveVersions(env, id, [v], 'manual')
  await audit(env, id, user.login, 'version', { version: v.version })
  await purge(request, env)
  return json(await versions(env, id), 201)
}

async function removeVersion(request, env, id, version) {
  const { user } = await editable(request, env, id)
  // a tombstone, so the nightly sync does not bring it back (adding it again by hand revives it)
  await env.DB.prepare("UPDATE releases SET source = 'removed' WHERE entry = ? AND version = ?").bind(id, version).run()
  await audit(env, id, user.login, 'unversion', { version })
  await purge(request, env)
  return json(await versions(env, id))
}

// --- publish from GitHub Actions (OIDC) -----------------------------------
// The maker's workflow asks GitHub for an OIDC token (audience "mutant.cloud") and posts it here.
// The token proves which repo the run belongs to, so no secrets are needed. We then read the
// release from GitHub ourselves, so nothing in the request body is trusted for GitHub-hosted files.

const OIDC_ISSUER = 'https://token.actions.githubusercontent.com'

const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0))

async function jwks() {
  const cache = caches.default
  const key = new Request(`${OIDC_ISSUER}/.well-known/jwks`)
  let res = await cache.match(key)
  if (!res) {
    res = await fetch(key)
    if (!res.ok) throw new HttpError(502, 'could not reach GitHub to check the token')
    res = new Response(res.body, { headers: { 'content-type': 'application/json', 'cache-control': 'max-age=3600' } })
    await cache.put(key, res.clone())
  }
  return (await res.json()).keys
}

async function verifyOidc(token, audience) {
  const parts = String(token || '').split('.')
  if (parts.length !== 3) throw new HttpError(401, 'send a GitHub Actions OIDC token as "Authorization: Bearer …"')
  let header, claims
  try {
    header = JSON.parse(new TextDecoder().decode(b64url(parts[0])))
    claims = JSON.parse(new TextDecoder().decode(b64url(parts[1])))
  } catch {
    throw new HttpError(401, 'that is not a valid token')
  }
  if (header.alg !== 'RS256') throw new HttpError(401, 'unexpected token type')
  const jwk = (await jwks()).find((k) => k.kid === header.kid)
  if (!jwk) throw new HttpError(401, 'unknown signing key')
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`))
  if (!ok) throw new HttpError(401, 'bad token signature')
  const now = Date.now() / 1000
  if (claims.iss !== OIDC_ISSUER) throw new HttpError(401, 'token is not from GitHub Actions')
  if (![].concat(claims.aud).includes(audience)) throw new HttpError(401, `token audience must be "${audience}"`)
  if (!(claims.exp > now) || claims.nbf > now + 60) throw new HttpError(401, 'token expired')
  return claims
}

async function publish(request, env) {
  const claims = await verifyOidc((request.headers.get('authorization') || '').replace(/^Bearer\s+/i, ''), env.OIDC_AUDIENCE || 'mutant.cloud')
  const repo = claims.repository
  const b = await body(request).catch(() => ({}))
  const tag = String(b.tag || '').trim() || (claims.ref?.startsWith('refs/tags/') ? claims.ref.slice(10) : '')
  // read the repo with the run's own short-lived token (sent by the action; it only covers this repo and
  // expires with the job), so no long-lived token is kept here. GITHUB_TOKEN is still used if set.
  const runToken = request.headers.get('x-github-token') || ''
  const gh = await repoInfo(repo, env.GITHUB_TOKEN || (/^gh[a-z]_[A-Za-z0-9_]+$/.test(runToken) ? runToken : undefined))
  if (!gh) throw new HttpError(400, `GitHub cannot see ${repo} (it must be public)`)
  if (gh.private) throw new HttpError(400, `${repo} is private: only public repos can be listed`)

  let row = await env.DB.prepare('SELECT id, locked FROM entries WHERE repo = ?').bind(repoKey(repo)).first()
  if (row?.locked) throw new HttpError(403, `the ${repo} listing is locked by the mutant.cloud admins, so publishes are paused`)
  let created = false
  const now = new Date().toISOString()
  if (!row) {
    // first publish lists the repo; extra fields (name, devices, tags…) may come in "listing"
    const { data, errors } = cleanInput({ name: gh.info.repo.split('/')[1], devices: ['fm1'], ...(b.listing || {}), repo })
    if (errors.length) throw new HttpError(400, errors.join(', '), { errors })
    const id = await freeId(env, data.name)
    await env.DB.prepare('INSERT INTO entries (id, repo, auto, data, created_by, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(id, repoKey(repo), JSON.stringify({ ...gh.info, sources: ['action'] }), JSON.stringify(data), `action:${claims.actor || repoOwner(repo)}`, now, now)
      .run()
    row = { id }
    created = true
  } else {
    const cur = await loadRow(env, row.id)
    const auto = { ...JSON.parse(cur.auto || '{}'), ...gh.info }
    await env.DB.prepare('UPDATE entries SET auto = ?, updated = ? WHERE id = ?').bind(JSON.stringify(auto), now, row.id).run()
  }

  await saveVersions(env, row.id, gh.all, 'github')
  // files hosted outside GitHub releases can be sent along with the tag
  if (tag && Array.isArray(b.assets) && b.assets.length && !gh.all.some((v) => v.version === tag)) {
    const v = cleanVersion({ ...b, version: tag })
    await checkAssets([v])
    await saveVersions(env, row.id, [v], 'action')
  }
  await audit(env, row.id, `action:${claims.actor || repoOwner(repo)}`, created ? 'create' : 'publish', { tag, run: claims.run_id, workflow: claims.workflow_ref })
  await purge(request, env)
  const e = effective(await loadRow(env, row.id))
  return json({ ok: true, created, id: row.id, url: `${new URL(request.url).origin}/#/p/${row.id}`, release: e.release || null, versions: e.versions || 0 }, created ? 201 : 200)
}

// --- admin activity --------------------------------------------------------

async function activity(env) {
  const [people, recent, releases] = await env.DB.batch([
    env.DB.prepare(`SELECT login, SUM(action = 'login') logins, MAX(CASE WHEN action = 'login' THEN at END) lastLogin,
      SUM(action != 'login') edits, MAX(CASE WHEN action != 'login' THEN at END) lastEdit,
      json_group_array(DISTINCT CASE WHEN entry != '' THEN entry END) entries
      FROM audit GROUP BY login ORDER BY MAX(at) DESC`),
    env.DB.prepare(`SELECT entry, login, action, at FROM audit WHERE action != 'login' ORDER BY n DESC LIMIT 40`),
    env.DB.prepare(`SELECT r.entry, SUM(r.date >= date('now', '-7 day')) week, SUM(r.date >= date('now', '-30 day')) month,
      COUNT(*) quarter, MAX(r.date) last FROM releases r JOIN entries e ON e.id = r.entry
      WHERE e.hidden = 0 AND r.date >= date('now', '-90 day') GROUP BY r.entry ORDER BY month DESC, last DESC`)
  ])
  return json(
    {
      people: people.results.map((p) => ({ ...p, entries: JSON.parse(p.entries).filter(Boolean) })),
      recent: recent.results,
      releases: releases.results
    },
    200,
    { 'cache-control': 'no-store' }
  )
}

// --- release watcher (cron) -----------------------------------------------
// Each run checks the repos checked longest ago, through their public releases feed
// (github.com/OWNER/REPO/releases.atom: no API, no token, no rate-limit budget). Only a tag it hasn't seen
// costs more: that release's page and file list, and a check of its .fwsc packages. Makers' CI publishes
// (/api/publish) still land instantly; this catches everyone else within a few hours.

const WATCH_BATCH = 20 // repos per run
const WATCH_BUDGET = 45 // outside requests per run (the free plan allows 50)
const WATCH_UA = { 'user-agent': 'mutant.cloud release watcher (+https://mutant.cloud)' }
const normTag = (t) =>
  String(t)
    .replace(/^v(?=\d)/i, '')
    .toLowerCase()

function parseAtom(xml) {
  const out = []
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const href = m[1].match(/<link[^>]+href="([^"]+)"/)?.[1] || ''
    const tag = href.includes('/releases/tag/') ? decodeURIComponent(href.split('/releases/tag/')[1]) : null
    if (tag) out.push({ tag, date: (m[1].match(/<updated>([^<]+)<\/updated>/)?.[1] || '').slice(0, 10) || undefined })
  }
  return out
}

// one release from its web pages: pre-release or not, and its files
async function readRelease(repo, { tag, date }) {
  const base = `https://github.com/${repo}/releases`
  const t = encodeURIComponent(tag)
  const [page, files] = await Promise.all([fetch(`${base}/tag/${t}`, { headers: WATCH_UA }), fetch(`${base}/expanded_assets/${t}`, { headers: WATCH_UA })])
  if (!page.ok || !files.ok) return null
  const prerelease = />\s*Pre-release\s*</.test(await page.text())
  const seen = new Set()
  const assets = []
  for (const m of (await files.text()).matchAll(/href="(\/[^"]+\/releases\/download\/[^"]+)"/g)) {
    const url = 'https://github.com' + m[1].replace(/&amp;/g, '&')
    if (seen.has(url)) continue
    seen.add(url)
    assets.push({ name: decodeURIComponent(url.split('/').pop()), url })
  }
  return {
    version: tag,
    date,
    url: `${base}/tag/${t}`,
    prerelease: prerelease || undefined,
    assets: assets
      .filter((a) => FIRMWARE_FILE.test(a.name) && !SOURCE_FILE.test(a.name))
      .sort((a, b) => /\.fwsc$/i.test(b.name) - /\.fwsc$/i.test(a.name))
      .slice(0, 12)
  }
}

async function watchReleases(env) {
  const { results } = await env.DB.prepare('SELECT id, repo, auto, watch_etag FROM entries WHERE repo IS NOT NULL AND hidden = 0 AND locked = 0 ORDER BY watched IS NOT NULL, watched LIMIT ?').bind(WATCH_BATCH).all()
  if (!results.length) return { checked: 0, added: [] }
  // every version each one has (removed ones too, so they stay removed)
  const known = new Map(results.map((r) => [r.id, new Set()]))
  const { results: have } = await env.DB.prepare(`SELECT entry, version FROM releases WHERE entry IN (${results.map(() => '?').join(',')})`)
    .bind(...results.map((r) => r.id))
    .all()
  for (const v of have) known.get(v.entry).add(normTag(v.version))

  let budget = WATCH_BUDGET
  const updates = []
  const added = []
  let checked = 0
  for (const row of results) {
    if (budget < 1) break
    const auto = JSON.parse(row.auto || '{}')
    const repo = auto.repo || row.repo
    budget--
    let res
    try {
      res = await fetch(`https://github.com/${repo}/releases.atom`, { headers: { ...WATCH_UA, ...(row.watch_etag ? { 'if-none-match': row.watch_etag } : {}) } })
    } catch {
      break
    }
    if (res.status === 429 || res.status >= 500) break // GitHub is busy: these come first next run
    const now = new Date().toISOString()
    checked++
    if (res.status !== 200) {
      // 304: nothing new since last time (404: gone; the sync deals with that)
      updates.push(env.DB.prepare('UPDATE entries SET watched = ? WHERE id = ?').bind(now, row.id))
      continue
    }
    const etag = res.headers.get('etag')
    const fresh = parseAtom(await res.text())
      .filter((f) => !known.get(row.id).has(normTag(f.tag)))
      .slice(0, 3)
    const got = []
    let finished = true
    for (const f of fresh) {
      if (budget < 2) {
        finished = false
        break
      }
      budget -= 2
      const v = await readRelease(repo, f)
      if (!v) continue
      const pkgs = v.assets.filter((a) => /\.fwsc$/i.test(a.name)).length
      if (pkgs > budget) {
        finished = false
        break
      }
      budget -= pkgs
      await checkAssets([v])
      got.push(v)
    }
    if (got.length) {
      await saveVersions(env, row.id, got, 'github')
      for (const v of got) {
        const newer = (r) => !r || (v.date || '') >= (r.date || '')
        if (!v.prerelease && newer(auto.release)) auto.release = v
        else if (v.prerelease && newer(auto.prerelease)) auto.prerelease = v
        if ((v.date || '') > (auto.updated || '')) auto.updated = v.date
        const devs = v.assets.map((a) => deviceOf(a.product)).filter(Boolean)
        if (devs.length) auto.devices = [...new Set([...(auto.devices || []), ...devs])]
        added.push(`${repo} ${v.version}`)
      }
    }
    // only marked as checked once all its new releases are in (otherwise it's first in line next run)
    if (finished) updates.push(env.DB.prepare('UPDATE entries SET watched = ?, watch_etag = ?, auto = ? WHERE id = ?').bind(now, etag, JSON.stringify(auto), row.id))
    else if (got.length) updates.push(env.DB.prepare('UPDATE entries SET auto = ? WHERE id = ?').bind(JSON.stringify(auto), row.id))
  }
  if (updates.length) await env.DB.batch(updates)
  if (added.length) console.log('new releases:', added.join(', '))
  return { checked, added }
}

// both jobs of a watcher run: new releases, and downloads that changed under the same version
async function watch(env) {
  const releases = await watchReleases(env)
  const files = await verifyFiles(env)
  return { ...releases, ...files }
}

// --- download re-checks ----------------------------------------------------
// GitHub release files and commit-pinned repo files don't change. Files on makers' own sites (and M-VAVE's)
// can be replaced in place, which breaks installers that verify the listed sha256 (fm1buddy). So the current
// release's other files are re-checked, oldest first: a conditional request costs nothing while a file is
// unchanged; a changed file is re-checked and its sha256 updated, with a dated note so people can see why.

const VERIFY_BATCH = 15 // listings per run
const VERIFY_BUDGET = 40 // outside requests per run (a full re-check counts 2)
const githubRelease = (u) => /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\//.test(u)
// files in a repo at a fixed commit can't change
const pinnedFile = (u) => /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[0-9a-f]{40}\//.test(u)
const daysSince = (d) => (Date.now() - Date.parse(d)) / 864e5
const hexOf = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

// re-check one listed file (mutates it); returns 'same', 'updated' (worth saving) or 'error' (try again later)
async function checkFile(a) {
  const today = new Date().toISOString().slice(0, 10)
  // (asked plainly while its flash chip is unknown: "not modified" wouldn't tell it)
  const headers = { ...WATCH_UA, ...(needsChip(a) ? {} : a.etag ? { 'if-none-match': a.etag } : a.lastModified ? { 'if-modified-since': a.lastModified } : {}) }
  let r
  try {
    r = await fetch(a.url, { headers, redirect: 'follow' })
  } catch {
    return 'error'
  }
  if (r.status === 304) return 'same'
  if (r.status === 404 || r.status === 410) {
    if (a.missing) return 'same'
    a.missing = today
    return 'updated'
  }
  if (!r.ok) return 'error'
  const buf = await r.arrayBuffer()
  if (buf.byteLength > 16 * 1024 * 1024) return 'error'
  let result = a.missing ? 'updated' : 'same'
  delete a.missing
  const sha = hexOf(await crypto.subtle.digest('SHA-256', buf))
  if (sha !== a.sha256) {
    const c = await check(buf, sha)
    if (!c) {
      if (!a.invalid) a.invalid = today
    } else {
      // replaced in place: list what's there now, so installers that verify it work again
      Object.assign(a, c, { replaced: today })
      delete a.invalid
    }
    result = 'updated'
  } else {
    if (a.invalid) {
      delete a.invalid
      result = 'updated'
    }
    if (needsChip(a)) {
      const c = await check(buf, sha)
      if (c?.chip) {
        a.chip = c.chip
        result = 'updated'
      }
    }
  }
  const etag = r.headers.get('etag') || undefined
  const lastModified = r.headers.get('last-modified') || undefined
  if (etag !== a.etag || lastModified !== a.lastModified) {
    Object.assign(a, { etag, lastModified })
    result = 'updated'
  }
  return result
}

// a GitHub release file: its download link redirects to the stored file, and a re-upload under the same name gets
// a new one. So one request (no download) tells whether it changed; the first time, the file is checked in full.
async function checkGithubFile(a) {
  const today = new Date().toISOString().slice(0, 10)
  let r
  try {
    r = await fetch(a.url, { headers: WATCH_UA, redirect: 'manual' })
  } catch {
    return 'error'
  }
  if (r.status === 404 || r.status === 410) {
    if (a.missing) return 'same'
    a.missing = today
    return 'updated'
  }
  const store = (r.headers.get('location') || '').split('?')[0]
  if (!store) return 'error'
  if (store === a.store && !a.missing && !needsChip(a)) return 'same'
  let c
  try {
    c = await inspect(a.url, { headers: WATCH_UA })
  } catch {
    return 'error'
  }
  const was = a.store
  Object.assign(a, { store, checked: today })
  delete a.missing
  if (!c) {
    a.invalid ||= today
    return 'updated'
  }
  delete a.invalid
  if (c.chip) a.chip = c.chip
  if (c.sha256 !== a.sha256) {
    Object.assign(a, c)
    // (on the first look there's no earlier copy to compare, but a different sha256 still means it changed)
    a.replaced = today
    if (!was) console.log('first check found a changed file:', a.url)
  }
  return 'updated'
}

// a file that can't change, checked before the flash chip check: just that (once)
async function addChip(a) {
  let c
  try {
    c = await inspect(a.url, { headers: WATCH_UA })
  } catch {
    return 'error'
  }
  // (a different file under the same address: not this one's chip, and it can't change, so it's left as it was)
  if (!c?.chip || c.sha256 !== a.sha256) return 'same'
  a.chip = c.chip
  return 'updated'
}

// a .fwsc whose check failed: try again (one that wasn't a package, at most weekly)
async function retryFile(a) {
  if (a.invalid && a.checked && daysSince(a.checked) < 7) return 'skip'
  const before = JSON.stringify(a)
  await checkAssets([{ assets: [a] }])
  return JSON.stringify(a) === before ? 'same' : 'updated'
}

async function verifyFiles(env) {
  const { results } = await env.DB.prepare('SELECT id, auto FROM entries WHERE hidden = 0 AND locked = 0 ORDER BY verified IS NOT NULL, verified LIMIT ?').bind(VERIFY_BATCH).all()
  if (!results.length) return { verified: 0, files: [] }
  const ids = results.map((r) => r.id)
  // the release (and pre-release) each one currently shows: the same pick the site makes
  const inIds = `WHERE entry IN (${ids.map(() => '?').join(',')})`
  const [a, b] = await env.DB.batch([env.DB.prepare(`SELECT * FROM (${LATEST}) ${inIds}`).bind(...ids), env.DB.prepare(`SELECT * FROM (${NEWEST}) ${inIds}`).bind(...ids)])
  // what each one shows, plus its newest release when that's a different (unchecked or broken) one
  const shown = [...a.results]
  for (const n of b.results) if (!shown.some((x) => x.entry === n.entry && x.version === n.version)) shown.push(n)
  let budget = VERIFY_BUDGET
  const now = new Date().toISOString()
  const stmts = []
  const files = []
  let verified = 0
  for (const row of results) {
    let finished = true
    const auto = JSON.parse(row.auto || '{}')
    let autoDirty = false
    for (const rel of shown.filter((l) => l.entry === row.id)) {
      const assets = JSON.parse(rel.assets || '[]')
      let dirty = false
      for (const a of assets) {
        if (!a.url || !/\.fwsc$/i.test(a.name)) continue
        const how = !a.sha256 ? retryFile : githubRelease(a.url) ? checkGithubFile : pinnedFile(a.url) ? (needsChip(a) ? addChip : null) : checkFile
        if (!how) continue
        if (budget < 2) {
          finished = false
          break
        }
        const before = JSON.stringify(a)
        const res = await how(a)
        if (res === 'skip') continue
        budget -= res === 'same' ? 1 : 2
        if (res === 'error') finished = false
        if (res === 'updated') {
          dirty = true
          const was = JSON.parse(before)
          if (a.replaced && a.replaced !== was.replaced) files.push(`${row.id}: ${a.name} replaced`)
          if (a.missing && !was.missing) files.push(`${row.id}: ${a.name} gone`)
          if (a.invalid && !was.invalid) files.push(`${row.id}: ${a.name} not a package`)
          if (a.sha256 && !was.sha256) files.push(`${row.id}: ${a.name} checked now`)
        }
      }
      if (dirty) {
        stmts.push(env.DB.prepare('UPDATE releases SET assets = ? WHERE entry = ? AND version = ?').bind(JSON.stringify(assets), row.id, rel.version))
        // the collected copy of the same release too
        for (const k of ['release', 'prerelease']) {
          if (auto[k]?.version === rel.version) {
            auto[k].assets = (auto[k].assets || []).map((x) => assets.find((y) => y.url === x.url) || x)
            autoDirty = true
          }
        }
      }
      if (!finished) break
    }
    if (autoDirty) stmts.push(env.DB.prepare('UPDATE entries SET auto = ? WHERE id = ?').bind(JSON.stringify(auto), row.id))
    if (finished) {
      verified++
      stmts.push(env.DB.prepare('UPDATE entries SET verified = ? WHERE id = ?').bind(now, row.id))
    }
    if (budget < 1) break
  }
  if (stmts.length) await env.DB.batch(stmts)
  if (files.length) console.log('downloads:', files.join(', '))
  return { verified, files }
}

// --- a listing's own link ---------------------------------------------------
// /<id> is the normal page (the site opens that listing), but link previews (Reddit, Discord, Mastodon, X...)
// show the listing: its name, maker, description and picture, so makers can share "their" page.

async function listingPage(request, env, url, id) {
  const page = await env.ASSETS.fetch(new Request(`${url.origin}/`))
  const row = await env.DB.prepare('SELECT * FROM entries WHERE id = ?').bind(id).first()
  if (!row || row.hidden) return page // (the site says it's not found)
  const e = effective((await withShots(env, attachLatest([row], [])))[0])
  const abs = (u) => (u && u.startsWith('/') ? url.origin + u : u)
  const image = abs(e.cover) || `${url.origin}/og.png`
  const square = e.coverIsScreen || !e.cover // a 240x240 screen (or none): the small card fits it better
  const title = `${e.name} by ${e.author}`
  const devices = e.devices.map((d) => DEVICES[d] || d).join(' & ')
  const desc = (e.description || `${e.kind === 'tool' ? 'A tool' : 'Firmware'} for the ${devices}.`).slice(0, 280)
  const link = `${url.origin}/${e.id}`
  const meta = {
    description: desc,
    'og:title': title,
    'og:description': desc,
    'og:url': link,
    'og:image': image,
    'og:image:alt': e.coverIsScreen ? `${e.name}'s screen` : e.name,
    'twitter:card': square && !e.cover ? 'summary_large_image' : square ? 'summary' : 'summary_large_image',
    'twitter:title': title,
    'twitter:description': desc,
    'twitter:image': image
  }
  const set = {
    element: (el) => {
      const k = el.getAttribute('property') || el.getAttribute('name')
      // the poster's size doesn't apply to the listing's own picture
      if ((k === 'og:image:width' || k === 'og:image:height') && e.cover) return el.remove()
      if (k in meta) el.setAttribute('content', meta[k])
    }
  }
  return new HTMLRewriter()
    .on('meta', set)
    .on('title', { element: (el) => el.setInnerContent(`${title} · mutant.cloud`) })
    .on('link[type="application/rss+xml"]', {
      element: (el) => {
        el.setAttribute('href', `/feed.xml?kind=all&author=${encodeURIComponent(authorKey(e))}`)
        el.setAttribute('title', `New from ${e.author} · mutant.cloud`)
      }
    })
    .on('head', { element: (el) => el.append(`<link rel="canonical" href="${link}" />`, { html: true }) })
    .transform(new Response(page.body, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' } }))
}

// --- device IDs ("FM-1_745") ------------------------------------------------
// The ID inside a package is what the device reports, and how installers and apps tell which firmware is running.
// GET /api/ids              every ID in use (by any version of any listing, old ones too) and who uses it
// GET /api/ids?check=ID     is this one free? (with a few free ones to pick from)

async function idsInUse(env) {
  const { results } = await env.DB.prepare("SELECT r.entry, r.version, r.assets, e.auto, e.data FROM releases r JOIN entries e ON e.id = r.entry WHERE r.source <> 'removed' AND e.hidden = 0 AND r.assets LIKE '%\"product\"%'").all()
  const ids = {}
  for (const r of results) {
    const name = { ...JSON.parse(r.auto || '{}'), ...JSON.parse(r.data || '{}') }.name || r.entry
    for (const a of JSON.parse(r.assets || '[]')) {
      if (!a.product) continue
      const list = (ids[a.product] ||= [])
      const have = list.find((x) => x.id === r.entry)
      if (have) have.versions.push(r.version)
      else list.push({ id: r.entry, name, versions: [r.version] })
    }
  }
  return ids
}

async function deviceIdsResponse(env, url) {
  const ids = await idsInUse(env)
  const check = url.searchParams.get('check')
  if (check === null) return json({ count: Object.keys(ids).length, ids }, 200, { 'cache-control': 'public, max-age=300' })
  const id = parseDeviceId(check)
  if (!id) return json({ check, valid: false, error: 'a device ID looks like FM-1_745 (or SMK-37 Pro_745, SMK-37 Elite_745, MKE-P37_745)' }, 400)
  const by = ids[id] || []
  // free numbers near the one asked for, for the same model
  const [model, n] = [id.slice(0, id.lastIndexOf('_')), Number(id.slice(id.lastIndexOf('_') + 1))]
  const suggestions = []
  for (let d = 1; suggestions.length < 5 && d < 5000; d++) {
    for (const k of [n + d, n - d]) {
      if (k > 0 && !ids[`${model}_${k}`] && suggestions.length < 5) suggestions.push(`${model}_${k}`)
    }
  }
  return json({ id, valid: true, taken: by.length > 0, by, suggestions: by.length ? suggestions : [] })
}
