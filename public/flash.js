// Installing a firmware from the browser over USB-MIDI (Chrome / Edge): find the device, ask what it is, check
// the package is for that model, then write it with the FM-1's update protocol (vendor/fm1ota.js, from fomajam).
// Used by the install sheet (app.js) and the rescue page (rescue.js).

import { Updater, sameModel } from './vendor/fm1ota.js'
import { productOf, logicalImage } from './vendor/fm1pkg.js'

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

export const DEVICE_NAMES = { 'FM-1': 'FM1', 'SMK-37 Pro': 'SMK-37 Pro', 'SMK-37 Elite': 'SMK-37 Elite', 'MKE-P37': 'MKE-P37' }
// "SMK-37 Pro_016" -> "SMK-37 Pro" (the update mode's "ota-FM-1_..." too)
export const modelOf = (product) =>
  String(product || '')
    .split('_')[0]
    .replace(/^ota-/i, '')
export const deviceName = (product) => DEVICE_NAMES[modelOf(product)] || modelOf(product)
export const isPackage = (a) => /\.fwsc$/i.test(a?.name || '') && !!DEVICE_NAMES[modelOf(a.product)]

const TEXT = {
  start: 'Starting',
  verify: 'Checking the package on the device',
  loader: 'Switching to update mode',
  write: 'Writing (keep it plugged in)',
  reboot: 'Restarting',
  done: 'Done: it runs the new firmware.',
  stopped: 'It stopped. Replug the USB cable and press Install again: the device stays in update mode until an install finishes.',
  // (the first step stopped: the running firmware read the package and turned it down, before update mode)
  refused: "It didn't start: the firmware on the device read the package and stopped, before anything was written. It still runs what it had. Switch it off and on, then try again.",
  // (M-VAVE's stock firmware won't install the version it already runs)
  same: "It's already running this firmware, and it won't install the same version over itself. Nothing was written. To put it on again, install another firmware first, then this one.",
  denied: 'MIDI (SysEx) was not allowed. Allow MIDI for this site (the icon in the address bar) and try again.',
  nomidi: 'This browser cannot talk to the device. Use Chrome or Edge on a computer.',
  notfound: 'No device found.',
  model: 'That package is for another device: ',
  lost: 'The USB connection was lost. Replug it and press Install again (it carries on where it stopped).',
  noloader: 'The device in update mode was not found. Replug the USB cable and press Install again.',
  noreturn: 'It did not come back by itself. Switch it off and on.',
  badreq: 'The device asked for something outside the package.'
}

const TIPS = `<ul class="tips">
  <li>Use a USB <b>data</b> cable (some only charge), straight into the computer, no hub.</li>
  <li>Switch the device on.</li>
  <li>Close everything else that uses MIDI: M-VAVE's app, editors, DAWs, other tabs.</li>
  <li>Chrome or Edge on a computer (not a phone or iPad).</li>
</ul>`

// fm1ota only asks ports with the names it knows (FM-1, SMK, Felucca, ...). Firmwares name their own (fomajam's is
// FOMAJAM), so when none of those answers, every port is asked (other gear ignores the identity question)
class HubUpdater extends Updater {
  async find(filter) {
    const dev = await super.find(filter)
    if (dev) return dev
    const known = this.names
    this.names = [...this.access.inputs.values()].map((p) => (p.name || '').toLowerCase()).filter(Boolean)
    try {
      return await super.find(filter)
    } finally {
      this.names = known
    }
  }
}

let busy = false
export const isBusy = () => busy
addEventListener('beforeunload', (e) => {
  if (busy) e.preventDefault()
})

let access = null
async function midi() {
  if (!navigator.requestMIDIAccess) throw Object.assign(new Error(TEXT.nomidi), { code: 'nomidi' })
  if (access) return access
  try {
    access = await navigator.requestMIDIAccess({ sysex: true })
  } catch {
    throw Object.assign(new Error(TEXT.denied), { code: 'denied' })
  }
  return access
}

// what's plugged in: { text: 'FM-1_015', model: 'FM-1', ota: in update mode (an install was cut off), rescue:
// fomajam's USB rescue } or null
export async function detect(log) {
  const dev = await new HubUpdater(await midi(), log).find()
  if (!dev) return null
  dev.link.close()
  return { text: dev.id.text, model: modelOf(dev.id.model), ota: /^ota-/i.test(dev.id.model), rescue: /_000$/.test(dev.id.text), port: dev.name }
}

export const describe = (dev) => (dev.ota ? `an ${esc(deviceName(dev.model))} in update mode: an install didn't finish. Installing now finishes it.` : dev.rescue ? `an ${esc(deviceName(dev.model))} in its USB rescue mode.` : `an ${esc(deviceName(dev.model))}, running <span class="mono">${esc(dev.text)}</span>.`)

const hex = async (raw) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', raw))].map((b) => b.toString(16).padStart(2, '0')).join('')

// a package: downloaded (url) or already here (raw), checked against what the listing says it is
async function load(pkg) {
  let raw = pkg.raw
  if (!raw) {
    const r = await fetch(pkg.url)
    if (!r.ok) throw new Error(`The download failed (HTTP ${r.status}). Nothing was written.`)
    raw = new Uint8Array(await r.arrayBuffer())
  }
  if (pkg.sha256 && (await hex(raw)) !== pkg.sha256) throw new Error("The download isn't the file the listing checked (its sha256 differs). Nothing was written.")
  const product = productOf(raw)
  if (pkg.product && product !== pkg.product) throw new Error(`The file says it is ${product}, the listing says ${pkg.product}. Nothing was written.`)
  return { raw, product }
}

// the device as it is now, the package, and the check that it's for that model
export function checkFor(dev, product) {
  if (!sameModel(dev.model, modelOf(product))) return `It's for the ${esc(deviceName(product))}, and this is ${describe(dev)} Nothing will be written.`
  return ''
}

// a two-step installer in el: "Find my device", then "Install" once the device is known and pick() said what goes
// on it. pick(dev): { pkg: { url | raw, sha256?, product, label }, note?: html }, { choices: [pkg, ...], note? } (the person
// picks one), or { problem: html }
export function mountFlasher(el, { pick, verb = 'Install', intro = '' }) {
  el.innerHTML = `<div class="flasher">
    ${intro}
    <div class="row"><button type="button" class="btn primary" data-find>Find my device</button><button type="button" class="btn" data-go disabled>${esc(verb)}</button></div>
    <div class="fl-status" role="status"></div>
    <progress max="100" value="0" hidden></progress>
    <details class="fl-log" hidden><summary>Details</summary><pre class="code"></pre></details>
  </div>`
  const q = (s) => el.querySelector(s)
  const find = q('[data-find]'),
    go = q('[data-go]'),
    st = q('.fl-status'),
    bar = q('progress'),
    pre = q('pre')
  const say = (html, cls = '') => {
    st.className = `fl-status ${cls}`
    st.innerHTML = html
  }
  const log = (t) => {
    q('.fl-log').hidden = false
    pre.textContent += t + '\n'
  }
  const lock = (b) => {
    busy = b
    find.disabled = b
  }
  let ready = null
  const next = (b) => {
    find.classList.toggle('primary', b === find)
    go.classList.toggle('primary', b === go)
  }

  find.onclick = async () => {
    ready = null
    go.disabled = true
    go.textContent = verb
    next(find)
    lock(true)
    say('Looking for it…')
    try {
      const dev = await detect(log)
      if (!dev) say(`<b>No device answered.</b>${TIPS}`, 'bad')
      else {
        log(`found ${dev.text}${dev.ota ? ' (update mode)' : ''} on "${dev.port}"`)
        const p = await pick(dev)
        if (p.problem) say(`Found ${describe(dev)}<br>${p.problem}`, 'bad')
        else if (p.choices) {
          // builds for the same model (variants): the first is picked until another is
          ready = { dev, pkg: p.choices[0] }
          const group = `fl-pick-${Math.random().toString(36).slice(2)}`
          say(`Found ${describe(dev)}<br>${p.note ? p.note + ' ' : ''}It has ${p.choices.length} builds for it. Pick one:<div class="choices">${p.choices.map((c, i) => `<label><input type="radio" name="${group}" value="${i}"${i ? '' : ' checked'} /> <span class="mono">${esc(c.label)}</span></label>`).join('')}</div>Keep it plugged in until it says done.`, 'ok')
          for (const r of st.querySelectorAll('input[type=radio]')) r.onchange = () => ready && (ready.pkg = p.choices[+r.value])
        } else {
          ready = { dev, pkg: p.pkg }
          const same = !dev.ota && dev.text === p.pkg.product
          say(`Found ${describe(dev)}<br>${p.note ? p.note + ' ' : ''}Ready to write <b>${esc(p.pkg.label)}</b>${same ? ' (it already runs this: installing again is fine)' : ''}. Keep it plugged in until it says done.`, 'ok')
        }
        if (ready) {
          go.textContent = `${verb} on this ${deviceName(dev.model)}`
          go.disabled = false
          next(go)
        }
      }
    } catch (e) {
      say(esc(e.message), 'bad')
    }
    lock(false)
  }

  go.onclick = async () => {
    if (!ready) return
    const { pkg } = ready
    ready = null
    go.disabled = true
    next(find)
    lock(true)
    bar.hidden = false
    bar.value = 0
    // what was plugged in, the package's identity, and whether the update loader was reached: to tell why it stopped
    let dev = null
    let want = ''
    let staged = false
    try {
      say(pkg.raw ? 'Checking the file…' : 'Downloading…')
      const { raw, product } = await load(pkg)
      // the device again, now: it may have been swapped or unplugged since the check
      dev = await detect(log)
      if (!dev) throw Object.assign(new Error(''), { code: 'notfound' })
      want = product
      const bad = checkFor(dev, product)
      if (bad) throw new Error(bad.replace(/<[^>]+>/g, ''))
      const up = new HubUpdater(await midi(), log)
      const image = logicalImage(raw)
      const total = 74 + Math.ceil(image.length / 512)
      const step = (k, a) => {
        if (k === 'loader') staged = true
        log(`${k} ${a ?? ''}`)
        if (TEXT[k]) say(esc(TEXT[k]))
        if (k === 'verify') bar.value = (100 * a) / total
        if (k === 'write') bar.value = (100 * (74 + a)) / total
      }
      let now = product
      if (dev.ota) {
        say(esc(TEXT.write))
        if (!(await up.resume(image, step, product))) throw Object.assign(new Error(''), { code: 'stopped' })
        step('reboot')
        const back = await up.waitFor((id) => !/^ota-/i.test(id.model), 40000)
        if (back) {
          back.link.close()
          now = back.id.text
        } else now = ''
      } else {
        try {
          now = await up.install(image, product, step)
        } catch (e) {
          // written, but it reports another identity (M-VAVE's stock firmware does): still done
          if (e.code !== 'mismatch') throw e
          now = e.detail
        }
      }
      bar.value = 100
      say(now ? `<b>Done.</b> It runs <span class="mono">${esc(now)}</span> now.` : "<b>Written.</b> Switch it off and on if it doesn't restart by itself.", 'ok')
    } catch (e) {
      // stopped before update mode: turned down by the running firmware (or it already runs this very package)
      if (e.code === 'stopped' && dev && !dev.ota && !staged) e.code = dev.text === want ? 'same' : 'refused'
      say(`${esc(TEXT[e.code] || '')}${TEXT[e.code] ? esc(e.detail || '') : esc(e.message)}${e.code === 'notfound' ? TIPS : ''}${['stopped', 'lost', 'noloader', 'refused'].includes(e.code) ? ' Or finish it from the <a href="/rescue">rescue page</a>.' : ''}`, 'bad')
      log(String(e?.stack || e))
    }
    lock(false)
  }
}
