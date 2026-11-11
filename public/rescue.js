// mutant.cloud/rescue: stock firmware back on, or an install that was cut off finished (flash.js)

import { mountFlasher, checkFor, deviceName, isPackage, isSmk, modelOf } from './flash.js'
import { productOf } from './vendor/fm1pkg.js'

const $ = (s) => document.querySelector(s)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const fmtSize = (n) => (n ? `${(n / 1024).toFixed(0)} KB` : '')

// the stock listing's files, one per model
async function stockFiles() {
  const data = await fetch('/firmware.json').then((r) => r.json())
  const e = data.entries.find((x) => x.stock)
  if (!e) throw new Error('The stock listing is missing.')
  return { e, files: (e.release?.assets || []).filter((a) => isPackage(a) && !a.missing && !a.invalid) }
}

stockFiles()
  .then(({ e, files }) => {
    $('#stockfiles').className = ''
    $('#stockfiles').innerHTML = `<ul class="files">${files.map((a) => `<li><span>${esc(deviceName(a.product))}</span><span class="mono">${esc(a.product)} · ${fmtSize(a.size)}</span></li>`).join('')}</ul>`
    mountFlasher($('#stock'), {
      verb: 'Install stock',
      pick(dev) {
        const a = files.find((x) => !checkFor(dev, x.product))
        if (!a) return { problem: "There's no stock file for that model here." }
        return { pkg: { url: `/dl/${e.id}/${encodeURIComponent(a.name)}`, sha256: a.sha256, product: a.product, label: `M-VAVE stock ${a.product}` } }
      }
    })
    // the wrong model: another SMK-37 model's stock (any, when it's in update mode: that could be either)
    const smk = files.filter((a) => isSmk(a.product))
    mountFlasher($('#smkmodel'), {
      verb: 'Install stock',
      pick(dev) {
        if (!isSmk(dev.model)) return { problem: 'This is for the SMK-37 and MKE-P37 only.' }
        const choices = smk.filter((a) => dev.ota || modelOf(a.product) !== dev.model).map((a) => ({ url: `/dl/${e.id}/${encodeURIComponent(a.name)}`, sha256: a.sha256, product: a.product, label: `${deviceName(a.product)} (M-VAVE stock ${a.product})`, anySmk: true }))
        if (!choices.length) return { problem: "There's no stock file for the other models here." }
        return { choices, ask: 'Pick the model on its box:' }
      }
    })
  })
  .catch((err) => {
    $('#stockfiles').textContent = `Couldn't load the stock files: ${err.message}`
  })

let own = null
mountFlasher($('#ownflash'), {
  pick(dev) {
    if (!own) return { problem: 'Choose a package first.' }
    const bad = checkFor(dev, own.product)
    return bad ? { problem: bad } : { pkg: own }
  }
})
$('#own').addEventListener('change', async (ev) => {
  own = null
  $('#owninfo').textContent = ''
  const f = ev.target.files[0]
  if (!f) return
  try {
    const raw = new Uint8Array(await f.arrayBuffer())
    const product = productOf(raw)
    if (!isPackage({ name: f.name, product })) throw new Error(`its device ID is "${product}"`)
    own = { raw, product, label: `${f.name} (${product})` }
    $('#owninfo').textContent = `${f.name}: ${product}, for the ${deviceName(product)}.`
  } catch (err) {
    $('#owninfo').textContent = `That isn't an FM1 / SMK-37 package: ${err.message}`
  }
})
