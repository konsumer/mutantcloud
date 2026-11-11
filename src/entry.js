// Shared data model for mutant.cloud entries (used by the worker and scripts/collect.js)

export const DEVICES = {
  fm1: 'FM1',
  smk37: 'SMK-37',
  tracker: 'Tracker',
  trackerplus: 'Tracker+',
  trackermini: 'Tracker Mini'
}

export const KINDS = {
  firmware: 'Firmware',
  tool: 'Tool'
}

// suggested tags (one click in the form, always in the filter bar). Makers can add their own too.
export const TAGS = {
  firmware: ['groovebox', 'synth', 'drums', 'sampler', 'tracker', 'chords', 'generative', 'game', 'midi', 'experimental', 'utility'],
  tool: ['editor', 'installer', 'emulator', 'librarian', 'plugin', 'presets', 'recovery', 'guide', 'app', 'sdk', 'hardware']
}

// firmware families (what it is built on): display name, and the repo that is the base.
// Forks of the repo (GitHub "parent") and repos made from it as a template are detected as built on it.
// `devices`: a base for other gear than the FM1 / SMK-37 (it isn't one of the FM1 guide's starting points)
export const BASE_INFO = {
  felucca: { name: 'Felucca', repo: 'hugelton/Felucca', license: 'GPL-3.0' },
  dinghy: { name: 'Dinghy', repo: 'zvenson/dinghy', license: 'GPL-3.0', template: true },
  fm1base: { name: 'fm1-base', repo: 'charlesvestal/fm1-base', license: 'MPL-2.0', template: true },
  foma: { name: 'FOMA', repo: 'konsumer/foma', license: 'GPL-3.0', template: true },
  sloop: { name: 'SLOOP', repo: 'isod89/sloop-fm1', license: 'GPL-3.0' },
  melodee: { name: 'Melodee', repo: 'keremimo/melodee', license: 'GPL-3.0' },
  fomni: { name: 'FoMni', repo: 'charlesvestal/fm1-fomni' },
  x0x: { name: 'X0X', repo: 'charlesvestal/fm1-x0x' },
  stock: { name: 'M-VAVE stock', repo: 'm-vave/fm1_open' },
  trackerce: { name: 'Tracker CE', repo: 'polyend/tracker-ce', license: 'MIT', devices: ['tracker', 'trackerplus', 'trackermini'] },
  original: { name: 'its own code' }
}
export const BASES = Object.keys(BASE_INFO)

// which base a repo is built on, from its GitHub template / fork parent (null if neither is a known base)
export function baseOfRepo(...related) {
  for (const r of related) {
    if (!r) continue
    const hit = Object.entries(BASE_INFO).find(([, v]) => v.repo && v.repo.toLowerCase() === r.toLowerCase())
    if (hit) return hit[0]
  }
  return null
}

// fields a person can set by hand (anything else comes from the collector)
export const EDITABLE = ['kind', 'name', 'author', 'authorUrl', 'repo', 'homepage', 'description', 'devices', 'tags', 'primaryTag', 'base', 'license', 'image', 'links', 'managers', 'beta', 'emulator']

const MAX = { name: 80, author: 80, description: 600, license: 40, label: 40, url: 400 }

export const slugify = (s) =>
  String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'entry'

// accepts "owner/name", a github URL, or git URL; returns "owner/name" or null
export function parseRepo(s) {
  if (!s) return null
  const m = String(s)
    .trim()
    .replace(/\.git$/, '')
    .match(/^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:)?([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})(?:[/?#].*)?$/)
  return m ? `${m[1]}/${m[2]}` : null
}

export const repoKey = (repo) => (repo ? repo.toLowerCase() : null)

// listings live at mutant.cloud/<id>, so these can never be ids (the site's own paths, and some for later)
export const RESERVED = new Set(['api', 'auth', 'dl', 'p', 'rescue', 'recover', 'recovery', 'restore', 'install', 'flash', 'vendor', 'make', 'new', 'mine', 'try', 'edit', 'versions', 'shots', 'firmware', 'catalog', 'about', 'admin', 'login', 'logout', 'static', 'assets', 'index', 'app', 'style', 'favicon', 'og', 'robots', 'sitemap', 'well-known', 'cdn-cgi', 'search', 'tags', 'tools', 'devices', 'help', 'docs', 'blog', 'news', 'feed', 'rss', 'atom'])

// who an author is in links and filters (?author=): their GitHub login if there's a repo, else their name as a
// slug. public/app.js has the same function; keep them in step.
const nameSlug = (s) =>
  String(s || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
export const authorKey = (e) => (e.github || nameSlug(e.author)).toLowerCase()

// the device IDs ("FM-1_745") a listing's current files report: what devices and apps identify it by
// (a Tracker's .ptf only names its model, "Tracker+", which isn't an ID: every Tracker firmware has it)
export const deviceIds = (e) => [...new Set([...(e.release?.assets || []), ...(e.prerelease?.assets || [])].map((a) => a.product).filter((p) => p && p.includes('_')))]

// a device ID as typed: "FM-1_745", "fm-1 745", or just "745" (an FM-1 one); null if it isn't one
export const ID_MODELS = ['FM-1', 'SMK-37 Pro', 'SMK-37 Elite', 'MKE-P37']
export function parseDeviceId(s) {
  const t = String(s || '').trim()
  if (/^\d{1,10}$/.test(t)) return `FM-1_${t}`
  const m = t.match(/^(fm-?1|smk-?37 ?pro|smk-?37 ?elite|mke-?p37)[ _-]*(\d{1,10})$/i)
  if (!m) return null
  const model = ID_MODELS.find((x) => x.replace(/[- ]/g, '').toLowerCase() === m[1].replace(/[- ]/g, '').toLowerCase())
  return model ? `${model}_${m[2]}` : null
}

// the list filters, shared by the site's links and the JSON endpoints:
//   device, kind (firmware | tool | all), tag, author, base, deviceId (exact: "FM-1_961"), q (all words must match)
export const FILTERS = ['device', 'kind', 'tag', 'author', 'base', 'deviceId', 'q']
export function matches(e, f) {
  if (f.device && f.device !== 'all' && !e.devices.includes(f.device)) return false
  if (f.kind && f.kind !== 'all' && e.kind !== f.kind) return false
  if (f.tag && !e.tags.includes(f.tag)) return false
  if (f.author && authorKey(e) !== f.author.toLowerCase()) return false
  if (f.base && e.base !== f.base) return false
  if (f.deviceId && !deviceIds(e).includes(parseDeviceId(f.deviceId))) return false
  if (f.q) {
    const hay = [e.name, e.author, e.description, e.repo, e.base, BASE_INFO[e.base]?.name, ...e.tags, ...deviceIds(e)].join(' ').toLowerCase()
    if (
      !f.q
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .every((w) => hay.includes(w))
    )
      return false
  }
  return true
}
export const repoOwner = (repo) => (repo ? repo.split('/')[0] : null)

export function cleanUrl(s) {
  if (!s) return null
  try {
    const u = new URL(String(s).trim())
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    const out = u.toString()
    return out.length <= MAX.url ? out : null
  } catch {
    return null
  }
}

// a file in a GitHub repo, as its direct download: github.com/o/r/blob/ref/path?raw=true and /raw/ links are
// redirects GitHub sometimes fails (504), raw.githubusercontent.com serves the file itself
export function rawGithub(s) {
  const m = String(s || '').match(/^https:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+?)(?:\?.*)?$/)
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}` : s
}

const str = (s, max) => {
  if (s == null) return null
  const t = String(s).replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, max) : null
}

const login = (s) => {
  const t = String(s || '')
    .trim()
    .replace(/^@/, '')
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(t) ? t : null
}

const uniq = (a) => [...new Set(a.filter(Boolean))]

export const MAX_TAGS = 10
export const cleanTag = (t) =>
  String(t || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || null

// sanitize user input (create / edit). Returns { data, errors }
export function cleanInput(body, { partial = false } = {}) {
  const data = {}
  const errors = []
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k)

  if (has('kind') || !partial) {
    data.kind = KINDS[body.kind] ? body.kind : 'firmware'
  }
  const kind = data.kind || body.kind || 'firmware'

  if (has('name') || !partial) {
    data.name = str(body.name, MAX.name)
    if (!data.name) errors.push('name is required')
  }
  if (has('author')) data.author = str(body.author, MAX.author)
  if (has('authorUrl')) data.authorUrl = cleanUrl(body.authorUrl)
  if (has('repo')) {
    data.repo = body.repo ? parseRepo(body.repo) : null
    if (body.repo && !data.repo) errors.push('repo must look like owner/name or a github.com URL')
  }
  if (has('homepage')) data.homepage = cleanUrl(body.homepage)
  if (has('description')) data.description = str(body.description, MAX.description)
  if (has('license')) data.license = str(body.license, MAX.license)
  if (has('image')) data.image = body.image ? cleanUrl(rawGithub(body.image)) : null
  if (has('beta')) data.beta = !!body.beta
  // false: no "Try" in the web emulator (the maker would rather send people to their own page or demo)
  if (has('emulator')) data.emulator = body.emulator !== false
  if (has('base')) data.base = BASES.includes(body.base) ? body.base : null
  // the flash chip as tested on a device, when reading the packages can't tell (or there are none): wins over them
  if (has('chip')) data.chip = ['new', 'old'].includes(body.chip) ? body.chip : null

  if (has('devices') || !partial) {
    data.devices = uniq((Array.isArray(body.devices) ? body.devices : []).filter((d) => DEVICES[d]))
    if (!data.devices.length) errors.push('pick at least one device')
  }
  if (has('tags')) {
    // any tag, as a short lowercase slug ("lo-fi", "drone", "ambient")
    data.tags = uniq((Array.isArray(body.tags) ? body.tags : String(body.tags || '').split(',')).map(cleanTag)).slice(0, MAX_TAGS)
  }
  if (has('primaryTag')) {
    // the main tag leads on the card and in the catalog; it is always one of the tags
    data.primaryTag = cleanTag(body.primaryTag)
    if (data.primaryTag && data.tags && !data.tags.includes(data.primaryTag)) data.tags = [data.primaryTag, ...data.tags].slice(0, MAX_TAGS)
  }
  if (has('links')) {
    data.links = (Array.isArray(body.links) ? body.links : [])
      .map((l) => ({ label: str(l?.label, MAX.label), url: cleanUrl(l?.url) }))
      .filter((l) => l.label && l.url)
      .slice(0, 12)
  }
  if (has('managers')) {
    const list = Array.isArray(body.managers) ? body.managers : String(body.managers || '').split(/[\s,]+/)
    data.managers = uniq(list.map(login)).slice(0, 10)
  }
  if (!partial && !data.repo && !data.homepage && !(data.links || []).length) {
    errors.push('give a GitHub repo, a homepage, or at least one link')
  }
  if (!partial && !data.repo && !data.author) {
    errors.push('author is required when there is no GitHub repo')
  }
  return { data, errors }
}

// the public view of an entry: collected data, overlaid with hand-edited data
export function effective(row) {
  const auto = typeof row.auto === 'string' ? JSON.parse(row.auto || '{}') : row.auto || {}
  const data = typeof row.data === 'string' ? JSON.parse(row.data || '{}') : row.data || {}
  const e = { ...auto }
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) e[k] = v
  }
  e.id = row.id
  e.kind = e.kind || 'firmware'
  // the repo comes from GitHub (it follows renames and transfers), never from what someone typed later
  e.repo = auto.repo || data.repo || null
  e.github = repoOwner(e.repo)
  // a "homepage" that is just the repo's GitHub page isn't a website (the repo link covers it)
  if (e.homepage && e.repo && parseRepo(e.homepage)?.toLowerCase() === e.repo.toLowerCase() && /^https?:\/\/(www\.)?github\.com\/[^/]+\/[^/?#]+\/?([?#].*)?$/i.test(e.homepage)) delete e.homepage
  e.author = e.author || e.github || 'unknown'
  if (!e.authorUrl && e.github && (!data.author || data.author === auto.author)) e.authorUrl = `https://github.com/${e.github}`
  e.devices = e.devices?.length ? e.devices : ['fm1']
  // the emulator screenshot, if one was taken (row.shot: its version in public/shots/index.json)
  // the emulator screenshot run couldn't get one: why (see public/app.js notes())
  if (row.shotFailed) e.emuCheck = row.shotFailed
  const screen = row.shot ? `/shots/${row.id}.png?v=${row.shot}` : auto.screen
  if (screen) e.screen = screen
  // the card's picture: the owner's, the maker's (their fmhub.json card, else a picture from their repo or site),
  // and only then the emulator's screenshot
  if (e.image) e.image = rawGithub(e.image)
  e.cover = rawGithub(data.image || auto.card || auto.image) || screen || null
  if (e.cover && e.cover === screen) e.coverIsScreen = true
  e.tags = e.tags || []
  // the owner's main tag, else the first one collected (the hubs list their main category first)
  e.primaryTag = (e.primaryTag && e.tags.includes(e.primaryTag) && e.primaryTag) || e.tags[0] || null
  // the main tag first
  if (e.primaryTag) e.tags = [e.primaryTag, ...e.tags.filter((t) => t !== e.primaryTag)]
  e.links = e.links || []
  e.managers = data.managers || []
  // newest versions from the release history win over whatever the sources said
  if (row.latest) {
    const { release, prerelease, count } = row.latest
    // the newest release you can install wins; without packages anywhere, simply the newest
    const installable = (r) => (r?.assets || []).some((a) => a.sha256)
    const later = (a, b) => (a?.date || '') >= (b?.date || '')
    if (release && (!e.release || (installable(release) && !installable(e.release)) || (installable(release) === installable(e.release) && later(release, e.release)))) e.release = release
    if (prerelease && (!e.release || (prerelease.date || '') > (e.release.date || ''))) e.prerelease = prerelease
    else if (e.prerelease && e.release && (e.prerelease.date || '') <= (e.release.date || '')) delete e.prerelease
    e.versions = count
    // a newer release than the one shown, which isn't installable (its file failed its check): say so
    const { newest } = row.latest
    if (newest && e.release && newest.version !== e.release.version && (newest.date || '') > (e.release.date || '') && !installable(newest) && (newest.assets || []).some((a) => /\.fwsc$/i.test(a.name))) e.newerUnchecked = newest
  }
  if (e.release && e.release.date > (e.updated || '')) e.updated = e.release.date
  // a build for RemoteFM1's players (Quixotic7/RemoteFM1FW, read by the sync): the remotefm1 tag, and its file
  if (auto.rfm1?.url) {
    e.rfm1 = auto.rfm1
    // (autoTags: added here, not chosen by anyone, so the edit form leaves them out and never saves them)
    if (!e.tags.includes('remotefm1')) {
      e.tags = [...e.tags, 'remotefm1']
      e.autoTags = ['remotefm1']
    }
  }
  // collected entries only get dates their sources gave; the row's own date is "added" only for entries made here
  const madeHere = !(auto.sources || []).some((x) => x !== 'user' && x !== 'action')
  if (!e.added && madeHere) e.added = row.created?.slice(0, 10)
  e.edited = Object.keys(data).length > 0
  if (row.hidden) e.hidden = true
  if (row.locked) e.locked = true
  // who added it here (people, not the collector): shown on entries without a repo, for accountability
  if (row.created_by) e.listedBy = row.created_by
  return order(e)
}

const ORDER = ['id', 'kind', 'name', 'author', 'authorUrl', 'github', 'repo', 'description', 'devices', 'tags', 'primaryTag', 'base', 'license', 'homepage', 'cover', 'coverIsScreen', 'image', 'screen', 'card', 'links', 'rfm1', 'release', 'prerelease', 'versions', 'beta', 'chip', 'emulator', 'stock', 'hid', 'archived', 'added', 'updated', 'managers', 'listedBy', 'sources', 'edited', 'hidden', 'locked']

function order(e) {
  const out = {}
  for (const k of ORDER) if (e[k] !== undefined && e[k] !== null) out[k] = e[k]
  for (const k of Object.keys(e)) if (!(k in out) && e[k] !== undefined && e[k] !== null) out[k] = e[k]
  return out
}

// can this session user manage this entry?
// repo owner and listed managers always can; admins can; people with push access to the repo can
export const isAdmin = (user, admins = []) => !!user && admins.some((a) => a.toLowerCase() === user.login.toLowerCase())

// a locked entry: admins only
export function canManage(entry, user, admins = []) {
  if (!user) return false
  const me = user.login.toLowerCase()
  if (isAdmin(user, admins)) return true
  if (entry.locked) return false
  if ((entry.managers || []).some((m) => m.toLowerCase() === me)) return true
  if (entry.repo) {
    if (repoOwner(entry.repo).toLowerCase() === me) return true
    if ((user.repos || []).includes(entry.repo.toLowerCase())) return true
  }
  return false
}
