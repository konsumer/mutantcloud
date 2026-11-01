// mutant.cloud front end: no build step, no framework

const $ = (s, el = document) => el.querySelector(s)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const safe = (u) => (/^https?:\/\//i.test(u || '') ? esc(u) : '#')
const ext = (u, label, cls = 'btn small') => `<a class="${cls}" href="${safe(u)}" target="_blank" rel="noopener">${esc(label)}</a>`

let DATA = { entries: [], devices: {}, kinds: {}, tags: {}, bases: {} }
// a base's display name (bases the other hubs use but we don't know stay as they are)
const baseName = (b) => DATA.bases[b]?.name || b
let ME = { user: null, manages: [] }

// the list's filters live in the URL, so any combination is a link:
//   ?author=konsumer&device=fm1   ?device=smk37   ?base=felucca&tag=drums   ?kind=tool
// the site opens on FM1 firmware; ?device=all shows every device
const DEFAULTS = { q: '', kind: 'firmware', device: 'fm1', tag: '', author: '', base: '', sort: 'updated' }
const state = { ...DEFAULTS }
function readUrl() {
  const p = new URLSearchParams(location.search)
  for (const k of Object.keys(DEFAULTS)) state[k] = p.get(k) || DEFAULTS[k]
  state.author = state.author.toLowerCase()
}
readUrl()
const query = (st) => {
  const p = new URLSearchParams()
  for (const k of Object.keys(DEFAULTS)) if (st[k] && st[k] !== DEFAULTS[k]) p.set(k, st[k])
  const qs = p.toString()
  return qs ? '/?' + qs : '/'
}
// a listing's own page: mutant.cloud/<id> (the worker puts its picture in the link previews)
const pageUrl = (e) => `${location.origin}/${e.id}`
const listingPath = () => location.pathname.match(/^\/([a-z0-9-]+)\/?$/)?.[1]
// a link to the list with these filters (the others stay as they are, so they combine)
const filterUrl = (patch) => query({ ...state, ...patch })

const slug = (s) =>
  String(s || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
// the same tag cleaning as the server (src/entry.js cleanTag)
const cleanTag = (t) => slug(t).slice(0, 24)
// tags in the filter bar: the suggested ones that are used, then makers' own tags once 2+ listings use them
function barTags() {
  const inKind = DATA.entries.filter((e) => state.kind === 'all' || e.kind === state.kind)
  const count = {}
  for (const e of inKind) for (const t of e.tags) count[t] = (count[t] || 0) + 1
  const suggested = (state.kind === 'all' ? [...new Set(Object.values(DATA.tags).flat())] : DATA.tags[state.kind] || []).filter((t) => count[t])
  const own = Object.keys(count)
    .filter((t) => !suggested.includes(t) && count[t] >= 2)
    .sort((a, b) => count[b] - count[a] || a.localeCompare(b))
  const list = [...suggested, ...own]
  if (state.tag && !list.includes(state.tag)) list.push(state.tag)
  return list
}
// who an author is in links: their GitHub login if there's a repo, else their name
const authorKey = (e) => (e.github || slug(e.author)).toLowerCase()
const authorLink = (e) => `<a class="flink" data-f href="${esc(filterUrl({ author: authorKey(e) }))}" title="Everything by ${esc(e.author)}">${esc(e.author)}</a>`

const hue = (id) => {
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return h % 360
}

const fmtDate = (d) => (d ? new Date(d.slice(0, 10) + 'T12:00:00Z').toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '')
const daysAgo = (d) => Math.floor((Date.now() - new Date(d.slice(0, 10) + 'T12:00:00Z')) / 864e5)
// "today", "3 days ago", "5 weeks ago", then the plain date
const when = (d) => {
  if (!d) return ''
  const n = daysAgo(d)
  if (n <= 0) return 'today'
  if (n === 1) return 'yesterday'
  if (n < 14) return `${n} days ago`
  if (n < 60) return `${Math.round(n / 7)} weeks ago`
  return fmtDate(d)
}
// the picture the owner set, if any (what the form shows): not the screenshot or maker card
const ownPic = (e) => (e.cover && !e.coverIsScreen && e.cover !== e.card ? e.cover : '')
// a GitHub issue about a listing, with the form's fields filled in (.github/ISSUE_TEMPLATE/listing.yml)
const ISSUES = 'https://github.com/konsumer/mutantcloud/issues/new'
const reportUrl = (e) => `${ISSUES}?template=listing.yml&title=${encodeURIComponent(`Listing: ${e.name}`)}&listing=${encodeURIComponent(`https://mutant.cloud/${e.id}`)}`

// device IDs ("FM-1_745"): what a listing's current files report (same as src/entry.js deviceIds)
const deviceIds = (e) => [...new Set([...(e.release?.assets || []), ...(e.prerelease?.assets || [])].map((a) => a.product).filter(Boolean))]
// other listings whose current files report the same device ID
// (built once per load of the list: device ID -> the listings that report it)
let ID_INDEX = { data: null, map: new Map() }
function sharedIds(e) {
  if (ID_INDEX.data !== DATA) {
    const map = new Map()
    for (const x of DATA.entries) for (const id of deviceIds(x)) map.set(id, [...(map.get(id) || []), x])
    ID_INDEX = { data: DATA, map }
  }
  const out = []
  for (const id of deviceIds(e)) {
    const others = (ID_INDEX.map.get(id) || []).filter((x) => x.id !== e.id)
    if (others.length) out.push({ id, others })
  }
  return out
}

const isNew = (e) => e.added && daysAgo(e.added) <= 14

// heads-ups about a listing's downloads and screenshot, as muted notes. warn: installing may not work right now
// (installers that verify the sha256, like fm1buddy, refuse it). info: worth knowing, nothing's broken.
function notes(e) {
  const out = []
  const assets = [...(e.release?.assets || []), ...(e.prerelease?.assets || [])]
  for (const a of assets) {
    if (a.unchecked && !a.sha256) out.push({ warn: true, text: `${a.name} couldn't be downloaded to check it (on ${fmtDate(a.unchecked)}). It's retried automatically; until then, installers that need a checked file (like fm1buddy) won't offer it.` })
    else if (a.missing) out.push({ warn: true, text: `${a.name} can't be downloaded (since ${fmtDate(a.missing)}). Installers will fail until the maker fixes the link.` })
    else if (a.invalid) out.push({ warn: true, text: `${a.name} isn't a valid FM-1 package any more (since ${fmtDate(a.invalid)}), so installers will refuse it.` })
    else if (a.replaced && daysAgo(a.replaced) <= 60) out.push({ text: `${a.name} was replaced on ${fmtDate(a.replaced)} without a new version number. It's been re-checked, so installers work; if you installed it before then, you have the older build.` })
  }
  const n = e.newerUnchecked
  if (n) {
    const why = (n.assets || []).some((a) => a.invalid) ? "its file isn't a valid FM-1 package" : (n.assets || []).some((a) => a.unchecked) ? "its file couldn't be downloaded to check it (it's retried automatically)" : 'its file is waiting to be checked'
    out.push({ warn: true, text: `There's a newer version, ${n.version} (${fmtDate(n.date)}), but ${why}. The version shown here is the latest one that checks out.` })
  }
  for (const { id, others } of sharedIds(e)) {
    const names =
      others
        .slice(0, 3)
        .map((x) => x.name)
        .join(', ') + (others.length > 3 ? ` and ${others.length - 3} more` : '')
    out.push({ text: `Its device ID, ${id}, is also used by ${names}. Devices and apps that tell which firmware is running by its ID (like fm1buddy) can't tell these apart.` })
  }
  const c = e.emuCheck
  if (c?.reason?.startsWith('sha256') && assets.some((a) => a.sha256 && a.sha256 === c.sha256)) {
    out.push({ warn: true, text: `The download doesn't match the file that was checked when it was listed (it was probably replaced in place). Installers that verify downloads, like fm1buddy, will refuse it until it's re-checked, which happens automatically within a few hours.` })
  } else if (c && !c.reason.startsWith('sha256') && !e.coverIsScreen) {
    out.push({ text: /blank/.test(c.reason) ? `No emulator screenshot: it showed a blank screen. That's often just a slow start, and it doesn't mean it won't run on a device.` : `No emulator screenshot (${c.reason}).` })
  }
  return out
}
const fmtSize = (n) => (n ? (n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.round(n / 1e3) + ' KB') : '')
const ghUrl = (e) => (e.repo ? `https://github.com/${e.repo}` : null)
// locked entries: admins only (the server enforces the same)
const canEdit = (e) => !!ME.user && (ME.user.admin || (!e.locked && ME.manages.some((m) => m.id === e.id)))
const find = (id) => DATA.entries.find((e) => e.id === id) || ME.manages.find((e) => e.id === id)

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw Object.assign(new Error(j.error || `error ${r.status}`), { data: j })
  return j
}

// --- primary actions ------------------------------------------------------

function files(e) {
  return (e.release?.assets || []).filter((a) => /^https?:/.test(a.url))
}

function getIt(e) {
  const install = e.links.find((l) => /^install/i.test(l.label))
  if (install) return { label: 'Install', url: install.url }
  const f = files(e)
  if (f.length === 1) return { label: 'Download', url: f[0].url }
  if (f.length > 1) return { label: `Files (${f.length})`, detail: true }
  if (e.release?.url) return { label: 'Release', url: e.release.url }
  if (e.homepage) return { label: 'Website', url: e.homepage }
  if (e.repo) return { label: 'Source', url: ghUrl(e) }
  return null
}

const tryIt = (e) => e.links.find((l) => /try|play|emulator|browser/i.test(l.label))

// --- the web emulator (joakimeriksson/fm1-emu, MIT) ------------------------
// It plays the firmwares in its own lists (?fw=<id>; ?embed=1 for just the device). Those lists are read
// live from its site, so firmware it adds later gets a "Try" button here without anyone doing anything.
const EMU = 'https://joakimeriksson.github.io/fm1-emu/'
let EMUMAP = null // repo (lowercase) or id -> { fm1: { id, version }, smk37: { id, version } }
const repoOfUrl = (u) =>
  String(u || '')
    .replace(/^https:\/\/github\.com\//, '')
    .split(/\/(tree|blob)\//)[0]
    .replace(/\/+$/, '')
    .toLowerCase()

async function loadEmulator() {
  try {
    const [fm1, smk] = await Promise.all([fetch(EMU + 'firmwares.json').then((r) => r.json()), fetch(EMU + 'smk37/firmwares.json').then((r) => r.json())])
    const map = new Map()
    const put = (key, dev, f) => {
      if (!key) return
      const m = map.get(key) || {}
      m[dev] ||= { id: f.id, version: f.version || '' }
      map.set(key, m)
    }
    const byId = new Map()
    for (const f of fm1.firmwares) {
      if (f.byo) continue // "bring your own file" (M-VAVE's): nothing to play without it
      byId.set(f.id, f)
      put(repoOfUrl(f.repo), 'fm1', f)
      put('id:' + f.id, 'fm1', f)
      if (f.hub) put('id:' + f.hub, 'fm1', f)
    }
    for (const f of smk.firmwares) {
      if (f.byo) continue
      put(repoOfUrl(f.repo), 'smk37', f)
      // an SMK-37 port: also under the FM-1 original it was ported from
      const twin = f.fm1 && byId.get(f.fm1)
      if (twin) put(repoOfUrl(twin.repo), 'smk37', f)
    }
    EMUMAP = map
  } catch {
    EMUMAP = new Map()
  }
  if (DATA.entries.length) {
    render()
    // an open "Try" link or detail sheet that arrived before the emulator's list: show it again, now with Try
    if (/^#\/(p|try)\//.test(location.hash) || listingPath()) route()
  }
}

// what the emulator can play of this listing (null: nothing, or the owner turned it off)
function emuFor(e) {
  if (!EMUMAP || e.kind !== 'firmware' || e.emulator === false) return null
  const m = (e.repo && EMUMAP.get(e.repo.toLowerCase())) || EMUMAP.get('id:' + e.id)
  if (!m) return null
  const out = {}
  for (const d of ['fm1', 'smk37']) if (m[d] && e.devices.includes(d)) out[d] = m[d]
  return Object.keys(out).length ? out : null
}
const emuUrl = (dev, id, embed) => `${EMU}${dev === 'smk37' ? 'smk37/' : ''}?fw=${encodeURIComponent(id)}${embed ? '&embed=1' : ''}`

// a card's buttons: the maker's website leads when there is one, then how to get it (installer or files),
// a browser demo, and the source. The same page never gets two buttons.
function cardButtons(e) {
  const out = []
  const seen = new Set()
  const add = (b) => {
    if (!b || (b.url && seen.has(b.url))) return
    if (b.url) seen.add(b.url)
    out.push(b)
  }
  if (e.homepage) add({ label: 'Website', url: e.homepage })
  add(getIt(e))
  const t = tryIt(e)
  if (emuFor(e)) add({ label: 'Try', href: `#/try/${e.id}` })
  else if (t) add({ label: 'Try it', url: t.url })
  if (e.repo) add({ label: 'Source', url: ghUrl(e) })
  return out.map((b, i) => {
    const cls = i === 0 ? 'btn small primary' : b.label === 'Source' ? 'btn small ghost' : 'btn small'
    if (b.href) return `<a class="${cls}" href="${esc(b.href)}" title="Play it in your browser, in the FM-1 emulator">▶ ${esc(b.label)}</a>`
    return b.detail ? `<a class="${cls}" href="#/p/${esc(e.id)}">${esc(b.label)}</a>` : ext(b.url, b.label, cls)
  })
}

// --- list -----------------------------------------------------------------

function filtered() {
  const words = state.q.toLowerCase().split(/\s+/).filter(Boolean)
  const list = DATA.entries.filter((e) => {
    if (state.kind !== 'all' && e.kind !== state.kind) return false
    if (state.device !== 'all' && !e.devices.includes(state.device)) return false
    if (state.tag && !e.tags.includes(state.tag)) return false
    if (state.author && authorKey(e) !== state.author) return false
    if (state.base && e.base !== state.base) return false
    if (!words.length) return true
    const hay = [e.name, e.author, e.description, e.repo, e.base, e.base && baseName(e.base), ...e.tags, ...deviceIds(e)].join(' ').toLowerCase()
    return words.every((w) => hay.includes(w))
  })
  const by = {
    updated: (a, b) => (b.updated || '').localeCompare(a.updated || ''),
    added: (a, b) => (b.added || '').localeCompare(a.added || ''),
    name: (a, b) => a.name.localeCompare(b.name)
  }[state.sort]
  return list.sort((a, b) => by(a, b) || a.name.localeCompare(b.name))
}

function card(e) {
  const dev = e.devices.map((d) => `<a class="badge dev flink" data-f href="${esc(filterUrl({ device: d }))}" title="All ${esc(DATA.devices[d] || d)} ${state.kind === 'tool' ? 'tools' : 'firmware'}">${esc(DATA.devices[d] || d)}</a>`).join('')
  const ver = e.release?.version ? `<span class="mono">${esc(e.release.version)}</span>` : ''
  const released = e.release?.date ? `Released ${when(e.release.date)}` : e.updated ? `Updated ${when(e.updated)}` : ''
  const pic = e.cover ? `<a class="pic${e.coverIsScreen ? ' screen' : ''}" href="#/p/${esc(e.id)}" tabindex="-1" aria-hidden="true">${e.coverIsScreen ? '' : `<img class="bg" src="${safe(e.cover)}" alt="" loading="lazy" decoding="async" />`}<img class="fg" src="${safe(e.cover)}" alt="" loading="lazy" decoding="async" onerror="this.parentNode.classList.add('none');this.parentNode.replaceChildren()" /></a>` : `<a class="pic none" href="#/p/${esc(e.id)}" tabindex="-1" aria-hidden="true"><span>${esc(e.name.slice(0, 1))}</span></a>`
  return `<article class="card" style="--h:${hue(e.id)}">
    ${pic}
    <div class="head">
      <h3><a href="#/p/${esc(e.id)}">${esc(e.name)}</a></h3>
      ${isNew(e) ? '<span class="badge new">new</span>' : ''}
    </div>
    <p class="by">by ${authorLink(e)}</p>
    ${e.description ? `<p class="desc">${esc(e.description)}</p>` : ''}
    <div class="meta">${e.primaryTag ? `<a class="badge tag flink" data-f href="${esc(filterUrl({ tag: e.primaryTag }))}" style="--h:${hue(e.primaryTag)}" title="All ${esc(e.primaryTag)}">${esc(e.primaryTag)}</a>` : ''}${dev}${e.beta ? '<span class="badge warn">beta</span>' : ''}${e.archived ? '<span class="badge warn">archived</span>' : ''}${ver}</div>
    ${notes(e).some((n) => n.warn) ? `<p class="warnline">⚠ Might not install right now: see details</p>` : ''}
    <p class="dates">${e.added ? `<span title="${esc(fmtDate(e.added))}">Added ${when(e.added)}</span>` : ''}${released ? `<span title="${esc(fmtDate(e.release?.date || e.updated))}">${released}</span>` : ''}</p>
    <div class="actions">${cardButtons(e).join('')}</div>
  </article>`
}

function render() {
  const list = filtered()
  $('#grid').innerHTML = list.length ? list.map(card).join('') : '<p class="empty">Nothing matches. Know one that is missing? <a href="#/new">Add it</a>.</p>'
  summary(list)
  // (on a listing's own page the address stays as it is, so it can be shared)
  if (!listingPath()) history.replaceState(history.state, '', query(state) + location.hash)
}

// "12 drums FM1 firmwares by konsumer, built on FOMA": what this link shows, with ways to undo each part
function summary(list) {
  const n = list.length
  const kind = { firmware: n === 1 ? 'firmware' : 'firmwares', tool: n === 1 ? 'tool' : 'tools', all: 'firmwares & tools' }[state.kind]
  const authorName = state.author ? DATA.entries.find((e) => authorKey(e) === state.author)?.author || state.author : ''
  const x = (patch, label) => `<a class="chip on" data-f href="${esc(filterUrl(patch))}" title="Remove">${label} <span aria-hidden="true">×</span></a>`
  const parts = [`<b>${n}</b>`, state.tag ? x({ tag: '' }, esc(state.tag)) : '', state.device !== 'all' ? x({ device: 'all' }, esc(DATA.devices[state.device] || state.device)) : '', esc(kind), state.author ? `by ${x({ author: '' }, esc(authorName))}` : '', state.base ? `built on ${x({ base: '' }, esc(baseName(state.base)))}` : '', state.q ? `matching ${x({ q: '' }, `“${esc(state.q)}”`)}` : ''].filter(Boolean)
  const filteredView = ['tag', 'device', 'author', 'base', 'q', 'kind'].some((k) => state[k] !== DEFAULTS[k])
  $('#count').innerHTML = parts.join(' ') + (filteredView ? ` <span class="filter-actions"><button type="button" class="btn small" id="copylink">Copy link</button><a class="btn small ghost" data-f href="${esc(query({ ...DEFAULTS, sort: state.sort }))}">Clear</a></span>` : '')
  const title = $('#count')
    .textContent.replace(/\s*×\s*/g, ' ')
    .replace(/Copy link.*$/, '')
    .trim()
  document.title = filteredView ? `${title} · mutant.cloud` : 'mutant.cloud · FM1 & SMK-37 firmware hub'
  const copy = $('#copylink')
  if (copy) {
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(location.origin + query(state))
        copy.textContent = 'Copied'
      } catch {
        copy.textContent = 'Copy failed'
      }
      setTimeout(() => (copy.textContent = 'Copy link'), 1600)
    }
  }
}

// filter links anywhere (cards, the detail sheet, the summary) change the list without reloading
document.addEventListener('click', (ev) => {
  const a = ev.target.closest('a[data-f]')
  if (!a || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button) return
  ev.preventDefault()
  if (dlg.open) dlg.close()
  history.pushState(null, '', a.getAttribute('href'))
  readUrl()
  $('#q').value = state.q
  controls()
  render()
  $('.controls').scrollIntoView({ block: 'start', behavior: 'smooth' })
})
window.addEventListener('popstate', () => {
  readUrl()
  $('#q').value = state.q
  controls()
  render()
  route()
})

function seg(el, options, key) {
  el.innerHTML = options.map(([v, label]) => `<button type="button" data-v="${esc(v)}" aria-pressed="${state[key] === v}">${esc(label)}</button>`).join('')
  el.onclick = (ev) => {
    const b = ev.target.closest('button')
    if (!b) return
    state[key] = b.dataset.v
    if (key === 'kind') state.tag = ''
    controls()
    render()
  }
}

function controls() {
  seg(
    $('#kind'),
    [
      ['firmware', 'Firmware'],
      ['tool', 'Tools'],
      ['all', 'All']
    ],
    'kind'
  )
  seg($('#device'), [['all', 'Any device'], ...Object.entries(DATA.devices)], 'device')
  $('#tags').innerHTML = barTags()
    .map((t) => `<button type="button" class="chip" data-t="${esc(t)}" style="--h:${hue(t)}" aria-pressed="${state.tag === t}">${esc(t)}</button>`)
    .join('')
  $('#tags').onclick = (ev) => {
    const b = ev.target.closest('button')
    if (!b) return
    state.tag = state.tag === b.dataset.t ? '' : b.dataset.t
    controls()
    render()
  }
  $('#sort').value = state.sort
}

function account() {
  const el = $('#account')
  const next = encodeURIComponent(location.pathname + location.search + location.hash)
  if (!ME.user) {
    el.innerHTML = `<a class="btn" href="/auth/login?next=${next}">Sign in</a>`
    return
  }
  el.innerHTML = `<a class="btn" href="#/new">+ Add</a>
    <a class="ghost" href="#/mine" title="Your projects"><img class="avatar" src="${safe(ME.user.avatar)}" alt="" /> Mine</a>`
}

// --- dialogs --------------------------------------------------------------

const dlg = $('#dlg')

function open(html, h = 340) {
  dlg.classList.remove('wide')
  $('#dlg-body').innerHTML = `<div class="sheet" style="--h:${h}"><button class="close" type="button" aria-label="Close">×</button>${html}</div>`
  $('.close', dlg).onclick = () => dlg.close()
  if (!dlg.open) dlg.showModal()
  dlg.scrollTop = 0
}

dlg.addEventListener('close', () => {
  // (removing the sheet also stops a running emulator)
  $('#dlg-body').replaceChildren()
  dlg.classList.remove('wide')
  if (location.hash.startsWith('#/') || listingPath()) history.pushState(null, '', (listingPath() ? '/' : location.pathname) + location.search)
})
dlg.addEventListener('click', (ev) => {
  if (ev.target === dlg) dlg.close()
})

function detail(e) {
  if (!e) return open('<h2 id="dlg-title">Not found</h2><p>That entry is gone or hidden.</p>')
  const f = files(e)
  const links = [...(e.homepage ? [{ label: 'Website', url: e.homepage }] : []), ...e.links, ...(e.repo ? [{ label: 'GitHub', url: ghUrl(e) }] : [])]
  const sources = { firmwarehub: 'The Firmware Hub', fmdb: 'FMDB', 'fm1-editor': 'FM1 Editor', user: 'mutant.cloud' }
  const next = encodeURIComponent(location.pathname + location.search + location.hash)
  let note = e.locked ? `<p class="note">🔒 Locked by the admins: its makers can't change it right now.${ME.user?.admin ? ' (You can, as an admin.)' : ''}</p>` : ''
  if (canEdit(e)) note += `<div class="formbar"><a class="btn" href="#/versions/${esc(e.id)}">Versions</a><a class="btn primary" href="#/edit/${esc(e.id)}">Edit listing</a></div>`
  else if (e.locked) note += ''
  else if (!ME.user) note = `<p class="note">Is this yours? <a href="/auth/login?next=${next}">Sign in with GitHub</a> to edit it.${e.repo ? ` Owners of <b>${esc(e.repo)}</b> can always manage it.` : ''}</p>`
  else note = `<p class="note">Only ${e.repo ? `the owner of <b>${esc(e.repo)}</b>, people who can push to it,` : ''} listed managers${e.managers.length ? ` (${e.managers.map(esc).join(', ')})` : ''} and admins can edit this. Ask one to add you as a manager.</p>`

  const rel = (r, label) => (r ? `<dt>${label}</dt><dd><span class="mono">${esc(r.version || '')}</span> ${r.date ? `· ${fmtDate(r.date)} <span class="by">(${when(r.date)})</span>` : ''} ${r.url ? `· <a href="${safe(r.url)}" target="_blank" rel="noopener">notes</a>` : ''}</dd>` : '')

  open(
    `<h2 id="dlg-title">${esc(e.name)}</h2>
    <p class="by">by ${authorLink(e)}${e.authorUrl ? ` · <a href="${safe(e.authorUrl)}" target="_blank" rel="noopener">${e.github ? 'GitHub' : 'website'} ↗</a>` : ''}</p>
    ${e.cover ? `<div class="shots"><img class="shot${e.coverIsScreen ? ' screen' : ''}" src="${safe(e.cover)}" alt="" loading="lazy" onerror="this.remove()" />${e.screen && !e.coverIsScreen ? `<img class="shot screen" src="${safe(e.screen)}" alt="Its screen, in the emulator" loading="lazy" onerror="this.remove()" />` : ''}</div>` : ''}
    ${e.description ? `<p class="lead">${esc(e.description)}</p>` : ''}
    <div class="actions">${emuFor(e) ? `<a class="btn primary" href="#/try/${esc(e.id)}">▶ Try it in your browser</a>` : ''}${links.map((l, i) => ext(l.url, l.label, i === 0 && !emuFor(e) ? 'btn primary' : 'btn')).join('')}<button type="button" class="btn ghost" data-copy="${esc(pageUrl(e))}" title="Its own page: shows its picture when you share it">Copy link</button></div>
    ${f.length ? `<h3>Files${e.release?.version ? ` <span class="mono by">${esc(e.release.version)}</span>` : ''}</h3>${fileList(f)}` : ''}
    <div id="history"></div>
    <dl class="facts">
      ${
        deviceIds(e).length
          ? `<dt>Device ID</dt><dd>${deviceIds(e)
              .map((id) => `<a class="mono" data-f href="${esc(query({ ...DEFAULTS, kind: 'all', device: 'all', q: id }))}" title="Everything that reports ${esc(id)}">${esc(id)}</a>`)
              .join(', ')}</dd>`
          : ''
      }
      <dt>Runs on</dt><dd>${e.devices.map((d) => `<a data-f href="${esc(query({ ...DEFAULTS, kind: e.kind, device: d }))}">${esc(DATA.devices[d] || d)}</a>`).join(', ')}</dd>
      ${e.tags.length ? `<dt>Tags</dt><dd>${e.tags.map((t) => `<a data-f href="${esc(query({ ...DEFAULTS, kind: e.kind, tag: t }))}">${t === e.primaryTag ? `<b>${esc(t)}</b>` : esc(t)}</a>`).join(', ')}</dd>` : ''}
      ${e.base ? `<dt>Built on</dt><dd><a data-f href="${esc(query({ ...DEFAULTS, base: e.base }))}" title="Everything built on ${esc(baseName(e.base))}">${esc(baseName(e.base))}</a>${DATA.bases[e.base]?.repo ? ` · <a href="https://github.com/${esc(DATA.bases[e.base].repo)}" target="_blank" rel="noopener">repo ↗</a>` : ''}</dd>` : ''}
      ${(() => {
        const n = DATA.entries.filter((x) => authorKey(x) === authorKey(e)).length
        return n > 1 ? `<dt>By ${esc(e.author)}</dt><dd><a data-f href="${esc(query({ ...DEFAULTS, kind: 'all', device: 'all', author: authorKey(e) }))}">all ${n} listings →</a></dd>` : ''
      })()}
      ${e.added ? `<dt>Added</dt><dd>${fmtDate(e.added)} <span class="by">(${when(e.added)})</span></dd>` : ''}
      ${rel(e.release, 'Latest release')}
      ${rel(e.prerelease, 'Pre-release')}
      ${e.versions > 1 ? `<dt>Versions</dt><dd>${e.versions} in its history, linked below (while the maker still hosts them)</dd>` : ''}
      ${e.license ? `<dt>License</dt><dd>${esc(e.license)}</dd>` : ''}
      ${e.updated ? `<dt>Last activity</dt><dd>${fmtDate(e.updated)} <span class="by">(${when(e.updated)})</span></dd>` : ''}
      ${!e.repo && e.listedBy ? `<dt>Listed by</dt><dd><a href="https://github.com/${esc(e.listedBy)}" target="_blank" rel="noopener">@${esc(e.listedBy)}</a></dd>` : ''}
      ${e.managers.length ? `<dt>Managed by</dt><dd>${e.managers.map((m) => `<a href="https://github.com/${esc(m)}" target="_blank" rel="noopener">${esc(m)}</a>`).join(', ')}</dd>` : ''}
      ${e.sources?.length ? `<dt>Also on</dt><dd>${e.sources.map((s) => esc(sources[s] || s)).join(', ')}</dd>` : ''}
      <dt>JSON</dt><dd><a href="/api/entries/${esc(e.id)}" class="mono">/api/entries/${esc(e.id)}</a></dd>
      <dt>Something wrong?</dt><dd><a href="${safe(reportUrl(e))}" target="_blank" rel="noopener">Report a problem with this listing ↗</a></dd>
    </dl>
    ${e.beta ? '<p class="note">Marked beta / experimental by its maker.</p>' : ''}
    ${notes(e)
      .map((n) => `<p class="note muted">${n.warn ? '⚠ ' : ''}${esc(n.text)}</p>`)
      .join('')}
    ${note}`,
    hue(e.id)
  )
  if (e.versions > 1) loadHistory(e)
  wireCopy()
}

const fileList = (f) => `<ul class="files">${f.map((a) => `<li><a href="${safe(a.url)}">${esc(a.name)}</a><span class="mono">${a.product ? `${esc(a.product)} · ` : ''}${fmtSize(a.size)}</span></li>`).join('')}</ul>`

async function loadHistory(e) {
  const list = await api(`/api/entries/${e.id}/releases`).catch(() => [])
  const el = $('#history')
  if (!el || !list.length) return
  el.innerHTML = `<details class="versions"><summary>All ${list.length} versions</summary>${list
    .map(
      (v) => `<div class="ver"><div><b class="mono">${esc(v.version)}</b>${v.prerelease ? ' <span class="badge warn">pre</span>' : ''} <span class="by">${fmtDate(v.date)} (${when(v.date)})</span>${v.url ? ` · <a href="${safe(v.url)}" target="_blank" rel="noopener">notes</a>` : ''}</div>
      ${v.assets.length ? fileList(v.assets) : ''}</div>`
    )
    .join('')}</details>`
}

function automate(e) {
  return `<details class="versions"><summary>Update this listing automatically</summary>
    <p>Add this workflow to <b>${esc(e.repo)}</b> as <code>.github/workflows/mutant.yml</code>. Every time you publish a GitHub release, the listing and its version history update right away. No secrets needed: GitHub proves the run comes from your repo.</p>
    ${codeBlock(WORKFLOW)}</details>`
}

const WORKFLOW = `name: mutant.cloud
on:
  release:
    types: [published]
permissions:
  id-token: write
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: konsumer/mutantcloud@main`

// a code block with a copy button
const codeBlock = (text) => `<div class="codewrap"><pre class="code">${esc(text)}</pre><button type="button" class="btn small copy" data-copy="${esc(text)}">Copy</button></div>`

function wireCopy() {
  for (const b of dlg.querySelectorAll('[data-copy]')) {
    b.onclick = async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.copy)
        b.textContent = 'Copied'
      } catch {
        b.textContent = 'Select and copy'
      }
      setTimeout(() => (b.textContent = 'Copy'), 1600)
    }
  }
}

// "Make your own": how to start, test, release, list and auto-update a firmware
function makeSheet() {
  const counts = {}
  for (const e of DATA.entries) if (e.base) counts[e.base] = (counts[e.base] || 0) + 1
  // every starting point we know, most built-upon first (no favourites)
  const starters = Object.entries(DATA.bases)
    .filter(([, b]) => b.repo && b.about)
    .sort(([a, x], [b, y]) => (counts[b] || 0) - (counts[a] || 0) || x.name.localeCompare(y.name))
  const next = encodeURIComponent('/#/new')
  const add = ME.user ? '<a class="btn primary" href="#/new">Add your firmware</a>' : `<a class="btn primary" href="/auth/login?next=${next}">Sign in with GitHub to add it</a>`
  open(
    `<h2 id="dlg-title">Make your own firmware</h2>
    <p class="lead">The FM1 and SMK-37 run custom firmware, and a lot of people write their own. Here's how to start one, and how to get it listed here and kept up to date without emailing anybody.</p>

    <h3><span class="num">1</span> Start from a base</h3>
    <p>Pick one, then make your own copy on GitHub: <b>Use this template</b> (a fresh repo) or <b>Fork</b>. Either way your listing shows what it's built on.</p>
    <ul class="starters">${starters
      .map(
        ([k, b]) => `<li style="--h:${hue(k)}">
          <div><b>${esc(b.name)}</b> <span class="by">${esc(b.repo)}${b.license ? ` · ${esc(b.license)}` : ''}${counts[k] ? ` · ${counts[k]} listed ${counts[k] === 1 ? 'firmware' : 'firmwares'} built on it` : ''}</span></div>
          <p>${esc(b.about)}</p>
          <span class="actions">${b.template ? ext(`https://github.com/${b.repo}/generate`, 'Use this template', 'btn small primary') : ext(`https://github.com/${b.repo}/fork`, 'Fork', 'btn small primary')}${ext(`https://github.com/${b.repo}`, 'Repo', 'btn small ghost')}</span>
        </li>`
      )
      .join('')}</ul>

    <h3><span class="num">2</span> Try it without flashing</h3>
    <p>The <a href="https://joakimeriksson.github.io/fm1-emu/" target="_blank" rel="noopener">FM-1 emulator</a> runs a <code>.fwsc</code> in your browser (FM1 and SMK-37), so you can check it boots before you put it on a device.</p>

    <h3><span class="num">3</span> Pick a device ID nobody else uses</h3>
    <p>Your package's device ID (like <code>FM-1_745</code>) is what the device reports, and how installers and apps tell which firmware is running. If two firmwares share one, they can't be told apart. Check yours against every version of every listing here:</p>
    <form class="idcheck" id="idcheck"><input name="id" placeholder="FM-1_745" maxlength="40" autocomplete="off" /><button class="btn small primary" type="submit">Check</button></form>
    <p class="idresult" id="idresult" role="status"></p>

    <h3><span class="num">4</span> Publish a release</h3>
    <p>Make a <a href="https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository" target="_blank" rel="noopener">GitHub release</a> and attach your <code>.fwsc</code> file(s): one per device if you build for several (FM1, SMK-37 Pro / Elite, MKE-P37). The hub reads each file's header to see which device it's for, checks its sha256, and remembers every version (it links to your files, it doesn't copy them).</p>
    <p class="by">Optional: an <code>fmhub.json</code> in your repo with <code>"image": "docs/card.png"</code> sets the picture on your card (the same file The Firmware Hub reads). Without one, the card shows your firmware's screen from the emulator.</p>

    <h3><span class="num">5</span> List it</h3>
    <p>Sign in with GitHub and add it. You can list a repo you own or can push to, and everyone who can push to it can manage the listing. Not on GitHub? You can add it anyway, with its real author's name on it; the listing also shows which account added it.</p>
    <p>Your listing has its own page, <code>mutant.cloud/&lt;its-id&gt;</code> (<b>Copy link</b> on it). Share that one: link previews on Reddit, Discord, Mastodon and the rest show your firmware's name, your name and its picture.</p>
    <p class="by">Only list firmware you made, or that its maker asked you to list. A listing's repo can't be changed after it's added (GitHub renames and transfers are followed automatically), and the admins can lock or remove listings that misrepresent someone's work.</p>
    <p>${add}</p>

    <h3><span class="num">6</span> Keep it updated automatically</h3>
    <p>Add this as <code>.github/workflows/mutant.yml</code> in your repo. Every release you publish shows up here right away, with its version history. It also lists your firmware on its first run, if you skipped step 5. No secrets or tokens to set up: GitHub proves the run comes from your repo.</p>
    ${codeBlock(WORKFLOW)}
    <p class="by">First run only, if it isn't listed yet: add <code>with:</code> <code>name: My Synth</code> and <code>devices: fm1,smk37</code> under the <code>uses:</code> line.</p>`,
    280
  )
  wireCopy()
  $('#idcheck').onsubmit = async (ev) => {
    ev.preventDefault()
    const out = $('#idresult')
    const r = await fetch(`/api/ids?check=${encodeURIComponent(ev.target.id.value)}`)
      .then((x) => x.json())
      .catch(() => null)
    if (!r) return (out.textContent = "Couldn't check right now, try again.")
    if (!r.valid) return (out.textContent = r.error)
    if (!r.taken) return (out.innerHTML = `✓ <b class="mono">${esc(r.id)}</b> isn't used by any listing here.`)
    out.innerHTML = `✗ <b class="mono">${esc(r.id)}</b> is taken by ${r.by.map((b) => `<a href="#/p/${esc(b.id)}">${esc(b.name)}</a>`).join(', ')}. Free nearby: ${r.suggestions.map((x) => `<code>${esc(x)}</code>`).join(', ')}`
  }
}

// the emulator in a popup: FM1 or SMK-37 if it has both
function trySheet(e, dev) {
  const emu = e && emuFor(e)
  if (!emu) return detail(e)
  const devs = Object.keys(emu)
  dev = emu[dev] ? dev : devs[0]
  const f = emu[dev]
  const own = tryIt(e)
  const latest = String(e.release?.version || '').replace(/^v(?=\d)/, '')
  const older = f.version && latest && f.version.replace(/^v(?=\d)/, '') !== latest
  open(
    `<h2 id="dlg-title">Try ${esc(e.name)}</h2>
    <p class="by">The real firmware, running in your browser in the <a href="https://github.com/joakimeriksson/fm1-emu" target="_blank" rel="noopener">FM-1 emulator</a>. Press Start, then play it with your mouse, computer keyboard or a MIDI keyboard.${older ? ` The emulator has version ${esc(f.version)}; the latest is ${esc(e.release.version)}.` : ''}</p>
    ${devs.length > 1 ? `<div class="seg emu-devs">${devs.map((d) => `<a class="${d === dev ? 'on' : ''}" href="#/try/${esc(e.id)}/${d}">${esc(DATA.devices[d] || d)}</a>`).join('')}</div>` : ''}
    <div class="emuframe${dev === 'smk37' ? ' smk' : ''}"><iframe src="${esc(emuUrl(dev, f.id, true))}" title="${esc(e.name)} in the FM-1 emulator" allow="autoplay; midi; fullscreen" loading="eager"></iframe></div>
    <div class="actions">${ext(emuUrl(dev, f.id, false), 'Open the full emulator ↗', 'btn')}${own ? ext(own.url, `${own.label} (the maker's) ↗`, 'btn') : ''}<a class="btn ghost" href="#/p/${esc(e.id)}">Back to ${esc(e.name)}</a></div>`,
    hue(e.id)
  )
  dlg.classList.add('wide')
}

async function versionsSheet(e) {
  if (!ME.user) return signInSheet('Sign in to manage versions.')
  if (!e || !canEdit(e)) return detail(e)
  const list = await api(`/api/entries/${e.id}/releases`).catch(() => [])
  open(
    `<h2 id="dlg-title">${esc(e.name)} versions</h2>
    <p class="by">The hub remembers every version you list and links to its files (it doesn't copy them), so people can find an older one while you still host it. Remove a version here to take it off the list.${e.repo ? ' GitHub releases show up by themselves (within a few hours, or right away with the workflow below).' : ''}</p>
    ${e.repo ? automate(e) : ''}
    <h3>Add a version</h3>
    <form class="edit" id="vform" novalidate>
      <div class="row2">
        <label class="field"><span>Version</span><input name="version" required placeholder="1.2.0" /></label>
        <label class="field"><span>Date</span><input name="date" type="date" value="${new Date().toISOString().slice(0, 10)}" /></label>
      </div>
      <label class="field"><span>Release page</span><input name="url" placeholder="https://… (notes / changelog)" /></label>
      <label class="field"><span>Files</span><textarea name="files" placeholder="One URL per line, e.g. https://example.com/my-fw-1.2.0.fwsc"></textarea></label>
      <div class="checks"><label><input type="checkbox" name="prerelease" />pre-release / beta</label></div>
      <p class="err" id="err" role="alert"></p>
      <div class="formbar"><a class="btn" href="#/p/${esc(e.id)}">Back</a><button class="btn primary" type="submit">Add version</button></div>
    </form>
    <h3>${list.length} ${list.length === 1 ? 'version' : 'versions'}</h3>
    <ul class="mine">${list
      .map(
        (v) => `<li style="--h:${hue(e.id)}"><span><b class="mono">${esc(v.version)}</b> <small class="by">${fmtDate(v.date)} · ${esc(v.source)} · ${v.assets.length} ${v.assets.length === 1 ? 'file' : 'files'}</small></span>
        <button class="btn small danger" type="button" data-del="${esc(v.version)}">Remove</button></li>`
      )
      .join('')}</ul>`,
    hue(e.id)
  )
  const f = $('#vform')
  f.onsubmit = async (ev) => {
    ev.preventDefault()
    $('#err').textContent = ''
    try {
      const assets = f.files.value
        .split(/\s+/)
        .filter(Boolean)
        .map((url) => ({ url, name: url.split('/').pop() }))
      await api(`/api/entries/${e.id}/releases`, { method: 'POST', body: JSON.stringify({ version: f.version.value, date: f.date.value, url: f.url.value, assets, prerelease: f.prerelease.checked }) })
      await reload()
      versionsSheet(find(e.id))
    } catch (err) {
      $('#err').textContent = err.message
    }
  }
  $('.mine', dlg).onclick = async (ev) => {
    const v = ev.target.dataset.del
    if (!v) return
    ev.target.disabled = true
    await api(`/api/entries/${e.id}/releases/${encodeURIComponent(v)}`, { method: 'DELETE' }).catch((err) => ($('#err').textContent = err.message))
    await reload()
    versionsSheet(find(e.id))
  }
}

function signInSheet(why) {
  const next = encodeURIComponent(location.pathname + location.search + location.hash)
  open(`<h2 id="dlg-title">Sign in</h2>
    <p class="lead">${esc(why)}</p>
    <p>Sign in with GitHub. Anything in a repo you own (or can push to) is yours to manage automatically. You can also add things that aren't on GitHub, and they'll show the real author, not you.</p>
    <p><a class="btn primary" href="/auth/login?next=${next}">Sign in with GitHub</a></p>`)
}

function mine() {
  if (!ME.user) return signInSheet('Manage your listings.')
  const list = ME.manages
  open(
    `<h2 id="dlg-title">Hi, ${esc(ME.user.name)}</h2>
    <p class="by">@${esc(ME.user.login)}${ME.user.admin ? ' · admin' : ''}</p>
    <p>${list.length ? `You can manage ${list.length} ${list.length === 1 ? 'listing' : 'listings'}: everything in repos you own or can push to, plus ones you are a manager of.` : "Nothing here yet. Add your firmware or tool and it'll show up here."}</p>
    <ul class="mine">${list
      .map(
        (e) => `<li style="--h:${hue(e.id)}"><span><b>${esc(e.name)}</b> <small class="by">${esc(e.author)}${e.hidden ? ' · hidden' : ''}${e.locked ? ' · 🔒 locked' : ''}</small></span>
        <span class="actions"><a class="btn small" href="#/p/${esc(e.id)}">View</a>${canEdit(e) ? `<a class="btn small primary" href="#/edit/${esc(e.id)}">Edit</a>` : ''}</span></li>`
      )
      .join('')}</ul>
    <div class="formbar"><button class="btn" type="button" id="logout">Sign out</button><a class="btn primary" href="#/new">+ Add a project</a></div>`
  )
  $('#logout').onclick = async () => {
    await api('/auth/logout', { method: 'POST' })
    ME = { user: null, manages: [] }
    account()
    dlg.close()
  }
}

// --- edit form ------------------------------------------------------------

const FIELDS = ['kind', 'name', 'author', 'authorUrl', 'repo', 'homepage', 'description', 'devices', 'tags', 'primaryTag', 'base', 'license', 'image', 'links', 'managers', 'beta', 'emulator']

function form(e) {
  if (!ME.user) return signInSheet(e ? 'Sign in to edit this listing.' : 'Sign in to add a project.')
  if (e && !canEdit(e)) return detail(e)
  const v = e || { kind: 'firmware', devices: ['fm1'], tags: [], links: [], managers: [] }
  const checks = (name, opts, sel) => `<div class="checks">${opts.map(([val, label]) => `<label><input type="checkbox" name="${name}" value="${esc(val)}" ${sel.includes(val) ? 'checked' : ''} />${esc(label)}</label>`).join('')}</div>`
  // the suggested tags for the kind, then this entry's own and other makers' popular ones
  const tagOpts = (kind, mine = []) => {
    const popular = {}
    for (const x of DATA.entries) if (x.kind === kind) for (const t of x.tags) popular[t] = (popular[t] || 0) + 1
    const extra = Object.keys(popular).filter((t) => popular[t] >= 2 && !(DATA.tags[kind] || []).includes(t))
    return [...new Set([...(DATA.tags[kind] || []), ...mine, ...extra])].map((t) => [t, t])
  }
  const linkRow = (l = {}) => `<div class="lrow"><input placeholder="Label (Install, Manual…)" value="${esc(l.label || '')}" data-l="label" /><input placeholder="https://…" value="${esc(l.url || '')}" data-l="url" /><button type="button" class="btn small" data-rm>×</button></div>`

  open(
    `<h2 id="dlg-title">${e ? `Edit ${esc(e.name)}` : 'Add a project'}</h2>
    <p class="by">${e ? 'Changes go live right away. Empty a field to fall back to what the hub collected.' : 'Got a GitHub repo? Paste it and the rest (releases, files, devices) fills in by itself.'}</p>
    <form class="edit" novalidate>
      <div class="row2">
        <label class="field"><span>Kind</span><select name="kind">${Object.entries(DATA.kinds)
          .map(([k, l]) => `<option value="${k}" ${v.kind === k ? 'selected' : ''}>${esc(l)}</option>`)
          .join('')}</select></label>
        <label class="field"><span>Name</span><input name="name" required maxlength="80" value="${esc(v.name || '')}" /></label>
      </div>
      <label class="field"><span>GitHub repo</span><input name="repo" placeholder="owner/name or https://github.com/owner/name" value="${esc(v.repo || '')}" ${e && !ME.user.admin ? 'readonly' : ''} />
        <small>${e ? (ME.user.admin ? 'Admin: you can repoint this. Renames and transfers on GitHub are followed automatically.' : 'Fixed once listed. Renames and transfers on GitHub are followed automatically; for anything else, ask an admin.') : 'Optional. It has to be a public repo you own or can push to (whoever can push to it can manage this listing).'}</small></label>
      <div class="row2">
        <label class="field"><span>Author (shown publicly)</span><input name="author" maxlength="80" value="${esc(e?.edited || !v.repo ? v.author || '' : v.author || '')}" />
          <small>The real maker, e.g. "Baud Girl". Defaults to the repo owner.</small></label>
        <label class="field"><span>Author link</span><input name="authorUrl" placeholder="https://…" value="${esc(v.authorUrl || '')}" /></label>
      </div>
      <label class="field"><span>Description</span><textarea name="description" maxlength="600">${esc(v.description || '')}</textarea></label>
      <div class="field"><span>Runs on</span>${checks('devices', Object.entries(DATA.devices), v.devices)}</div>
      <div class="field"><span>Tags</span><div id="tagbox">${checks('tags', tagOpts(v.kind, v.tags), v.tags)}</div>
        <div class="tagadd"><input id="newtag" placeholder="Add your own: lo-fi, drone, live-looping…" maxlength="80" /><button type="button" class="btn small" id="addtag">Add</button></div>
        <small>Pick any that fit, and add your own if they're missing: they're searchable and linkable right away, and show in the filter bar once two listings use them.</small></div>
      <label class="field"><span>Main tag</span><select name="primaryTag" id="primarytag"></select>
        <small>The one it's best described by. It leads on the card and in the hub-format catalog.</small></label>
      <div class="row2">
        <label class="field"><span>Homepage</span><input name="homepage" placeholder="https://…" value="${esc(v.homepage || '')}" /></label>
        <label class="field"><span>Built on</span><select name="base"><option value="">—</option>${Object.keys(DATA.bases)
          .map((b) => `<option value="${esc(b)}" ${v.base === b ? 'selected' : ''}>${esc(baseName(b))}</option>`)
          .join('')}</select></label>
      </div>
      <div class="row2">
        <label class="field"><span>License</span><input name="license" maxlength="40" placeholder="GPL-3.0, MIT, closed…" value="${esc(v.license || '')}" /></label>
        <label class="field"><span>Picture URL</span><input name="image" placeholder="https://…png" value="${esc(ownPic(v))}" />
          <small>Your own picture for the card. Empty: your fmhub.json card image, else a screenshot from the emulator.</small></label>
      </div>
      <div class="field"><span>Links</span><div class="links-ed" id="links">${(v.links.length ? v.links : [{}]).map(linkRow).join('')}</div>
        <button type="button" class="btn small" id="addlink" style="justify-self:start">+ link</button>
        <small>Installer, browser demo, manual, editor, cheat sheet… "Install" links become the main button.</small></div>
      <label class="field"><span>Managers</span><input name="managers" placeholder="github logins, comma separated" value="${esc((v.managers || []).join(', '))}" />
        <small>GitHub users who can edit this too. Repo owners don't need to be listed.</small></label>
      <div class="checks"><label><input type="checkbox" name="beta" ${v.beta ? 'checked' : ''} />beta / experimental</label><label title="When the FM-1 emulator has this firmware, a ▶ Try button plays it right here. Turn it off to point people at your own website or demo instead."><input type="checkbox" name="emulator" ${v.emulator === false ? '' : 'checked'} />▶ Try in the emulator</label></div>
      ${
        e
          ? ''
          : `<div class="note warn">
        <p><b>Only add firmware you made</b>, or that its maker asked you to list. Listings that misrepresent someone else's work are removed, and the account that added them is shown on the listing.</p>
        <label class="confirm"><input type="checkbox" name="confirm" required /> I made this, or I have its maker's permission to list it.</label>
      </div>`
      }
      <p class="err" id="err" role="alert"></p>
      <div class="formbar">
        <span class="actions">${e ? `${e.repo ? '<button type="button" class="btn" id="refresh">Refresh from GitHub</button>' : ''}<button type="button" class="btn" id="hide">${e.hidden ? 'Unhide' : 'Hide'}</button>${ME.user.admin ? `<button type="button" class="btn" id="lock">${e.locked ? 'Unlock' : '🔒 Lock'}</button>` : ''}` : ''}</span>
        <span class="actions">${e ? `<a class="btn" href="#/p/${esc(e.id)}">Cancel</a>` : ''}<button class="btn primary" type="submit">${e ? 'Save' : 'Add it'}</button></span>
      </div>
    </form>`,
    e ? hue(e.id) : 200
  )

  const f = $('form.edit', dlg)
  const chosen = () => [...f.querySelectorAll('[name=tags]:checked')].map((i) => i.value)
  // the main-tag picker follows the ticked tags
  const syncPrimary = (want) => {
    const sel = $('#primarytag')
    const keep = want ?? sel.value
    const tags = chosen()
    sel.innerHTML = tags.length ? tags.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('') : '<option value="">(tick a tag)</option>'
    sel.value = tags.includes(keep) ? keep : tags[0] || ''
  }
  syncPrimary(v.primaryTag || v.tags[0])
  $('#tagbox').onchange = () => syncPrimary()
  const addTags = () => {
    const box = $('#tagbox .checks')
    for (const t of $('#newtag').value.split(',').map(cleanTag).filter(Boolean)) {
      const have = box.querySelector(`input[value="${CSS.escape(t)}"]`)
      if (have) have.checked = true
      else box.insertAdjacentHTML('beforeend', `<label><input type="checkbox" name="tags" value="${esc(t)}" checked />${esc(t)}</label>`)
    }
    $('#newtag').value = ''
    syncPrimary()
  }
  $('#addtag').onclick = addTags
  $('#newtag').onkeydown = (ev) => {
    if (ev.key === 'Enter' || ev.key === ',') {
      ev.preventDefault()
      addTags()
    }
  }
  f.kind.onchange = () => {
    $('#tagbox').innerHTML = checks('tags', tagOpts(f.kind.value, chosen()), chosen())
    syncPrimary()
  }
  $('#addlink').onclick = () => $('#links').insertAdjacentHTML('beforeend', linkRow())
  $('#links').onclick = (ev) => {
    if (ev.target.matches('[data-rm]')) ev.target.closest('.lrow').remove()
  }

  const read = () => ({
    kind: f.kind.value,
    name: f.name.value,
    repo: f.repo.value.trim() || null,
    author: f.author.value.trim() || null,
    authorUrl: f.authorUrl.value.trim() || null,
    description: f.description.value.trim() || null,
    devices: [...f.querySelectorAll('[name=devices]:checked')].map((i) => i.value),
    tags: chosen(),
    primaryTag: f.primaryTag.value || null,
    homepage: f.homepage.value.trim() || null,
    base: f.base.value || null,
    license: f.license.value.trim() || null,
    image: f.image.value.trim() || null,
    links: [...f.querySelectorAll('.lrow')].map((r) => ({ label: $('[data-l=label]', r).value.trim(), url: $('[data-l=url]', r).value.trim() })).filter((l) => l.label || l.url),
    managers: f.managers.value.split(/[\s,]+/).filter(Boolean),
    beta: f.beta.checked,
    emulator: f.emulator.checked
  })

  // only send what changed, so collected data keeps flowing for everything else
  const diff = (now) => {
    if (!e) return now
    const out = {}
    for (const k of FIELDS) {
      const set = (x) => (k === 'tags' && Array.isArray(x) ? [...x].sort() : x)
      const a = JSON.stringify(set(now[k]) ?? null)
      const was = set(k === 'image' ? ownPic(e) || null : e[k])
      const b = JSON.stringify(was ?? (Array.isArray(now[k]) ? [] : k === 'beta' ? false : k === 'emulator' ? true : null))
      if (a !== b) out[k] = now[k]
    }
    return out
  }

  const busy = async (fn) => {
    $('#err').textContent = ''
    f.querySelectorAll('button').forEach((b) => (b.disabled = true))
    try {
      await fn()
    } catch (err) {
      $('#err').innerHTML = esc(err.message) + (err.data?.id ? ` <a href="#/p/${esc(err.data.id)}">See it</a>` : '')
    } finally {
      f.querySelectorAll('button').forEach((b) => (b.disabled = false))
    }
  }

  f.onsubmit = (ev) => {
    ev.preventDefault()
    busy(async () => {
      const body = diff(read())
      if (e && !ME.user.admin) delete body.repo
      if (!e) {
        if (!f.confirm.checked) throw new Error('Tick the box to confirm you made this (or have permission to list it).')
        body.confirm = true
      }
      if (e && !Object.keys(body).length) return detail(e)
      const saved = e ? await api(`/api/entries/${e.id}`, { method: 'PATCH', body: JSON.stringify(body) }) : await api('/api/entries', { method: 'POST', body: JSON.stringify(body) })
      await reload()
      location.hash = `#/p/${saved.id}`
    })
  }
  if (e) {
    const r = $('#refresh')
    if (r) {
      r.onclick = () =>
        busy(async () => {
          await api(`/api/entries/${e.id}/refresh`, { method: 'POST' })
          await reload()
          form(find(e.id))
        })
    }
    const lock = $('#lock')
    if (lock) {
      lock.onclick = () =>
        busy(async () => {
          await api(`/api/entries/${e.id}`, { method: 'PATCH', body: JSON.stringify({ locked: !e.locked }) })
          await reload()
          form(find(e.id))
        })
    }
    $('#hide').onclick = () =>
      busy(async () => {
        await api(`/api/entries/${e.id}`, { method: 'PATCH', body: JSON.stringify({ hidden: !e.hidden }) })
        await reload()
        mine()
      })
  }
}

// --- routing + boot -------------------------------------------------------

function route() {
  const h = location.hash
  let m
  if ((m = h.match(/^#\/p\/([a-z0-9-]+)/))) detail(find(m[1]))
  else if ((m = h.match(/^#\/edit\/([a-z0-9-]+)/))) form(find(m[1]))
  else if ((m = h.match(/^#\/versions\/([a-z0-9-]+)/))) versionsSheet(find(m[1]))
  else if (h === '#/new') form(null)
  else if (h === '#/mine') mine()
  else if (h === '#/make') makeSheet()
  else if ((m = h.match(/^#\/try\/([a-z0-9-]+)(?:\/(fm1|smk37))?/))) trySheet(find(m[1]), m[2])
  else if (listingPath() && find(listingPath())) detail(find(listingPath()))
  else if (dlg.open) dlg.close()
}

loadEmulator()

async function reload() {
  const [data, me] = await Promise.all([fetch('/firmware.json', { cache: 'no-store' }).then((r) => r.json()), api('/api/me').catch(() => ({ user: null, manages: [] }))])
  DATA = data
  ME = me
  const makers = new Set(DATA.entries.map((e) => (e.github || e.author).toLowerCase()))
  $('#stats').textContent = `${DATA.count} firmwares & tools from ${makers.size} makers. Self-serve: makers sign in with GitHub and keep their own listings up to date.`
  account()
  controls()
  render()
}

let t
$('#q').value = state.q
$('#q').oninput = (ev) => {
  clearTimeout(t)
  t = setTimeout(() => {
    state.q = ev.target.value
    render()
  }, 80)
}
$('#sort').onchange = (ev) => {
  state.sort = ev.target.value
  render()
}
window.addEventListener('hashchange', route)

reload()
  .then(route)
  .catch((err) => {
    $('#stats').textContent = 'Could not load the list. ' + err.message
  })
