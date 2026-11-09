#!/usr/bin/env node
// npm run chips: fill in the flash chip (src/pkg.js chip()) of every FM-1 package listed before the check existed,
// in every version, straight into the database. The watcher does the same slowly; this does it now.
// Only a file whose download still has the sha256 on record gets it.

import { writeFileSync } from 'node:fs'
import { inspect, needsChip } from '../src/pkg.js'
import { wrangler, parseJson, DB_NAME, ROOT } from './wrangler.js'

const UA = { 'user-agent': 'mutant.cloud chip check (+https://mutant.cloud)' }
const read = (sql) => parseJson(wrangler(['d1', 'execute', DB_NAME, '--remote', '--json', '--command', sql], { quiet: true }))[0]?.results || []

const rows = () => [read(`SELECT entry, version, assets FROM releases WHERE assets LIKE '%FM-1%'`), read(`SELECT id, auto FROM entries WHERE auto LIKE '%FM-1%'`)]
let [releases, entries] = rows()

// every file that needs it: url -> sha256 on record
const want = new Map()
const lists = [...releases.map((r) => JSON.parse(r.assets || '[]')), ...entries.flatMap((e) => ['release', 'prerelease'].map((k) => JSON.parse(e.auto || '{}')[k]?.assets || []))]
for (const assets of lists) for (const a of assets) if (a.url && needsChip(a)) want.set(a.url, a.sha256)
console.log(`${want.size} packages to check`)

const found = new Map()
const todo = [...want]
let done = 0
await Promise.all(
  Array.from({ length: 8 }, async () => {
    while (todo.length) {
      const [url, sha] = todo.shift()
      const c = await inspect(url, { headers: UA }).catch(() => null)
      if (c?.chip && c.sha256 === sha) found.set(url, c.chip)
      if (++done % 50 === 0) console.log(`  ${done}/${want.size}`)
    }
  })
)
const tally = {}
for (const c of found.values()) tally[c] = (tally[c] || 0) + 1
console.log(`  read ${found.size}:`, tally)

// (read again: the watcher may have changed some while the files downloaded)
;[releases, entries] = rows()
const q = (s) => `'${String(s).replace(/'/g, "''")}'`
const fill = (assets) => {
  let changed = false
  for (const a of assets) {
    if (found.has(a.url) && a.sha256 === want.get(a.url) && !a.chip) {
      a.chip = found.get(a.url)
      changed = true
    }
  }
  return changed
}
const sql = []
for (const r of releases) {
  const assets = JSON.parse(r.assets || '[]')
  if (fill(assets)) sql.push(`UPDATE releases SET assets = ${q(JSON.stringify(assets))} WHERE entry = ${q(r.entry)} AND version = ${q(r.version)};`)
}
for (const e of entries) {
  const auto = JSON.parse(e.auto || '{}')
  let changed = false
  for (const k of ['release', 'prerelease']) if (auto[k]?.assets && fill(auto[k].assets)) changed = true
  if (changed) sql.push(`UPDATE entries SET auto = ${q(JSON.stringify(auto))} WHERE id = ${q(e.id)};`)
}
if (!sql.length) {
  console.log('✓ nothing to fill in')
  process.exit(0)
}
const file = `${ROOT}data/chips.sql`
writeFileSync(file, sql.join('\n') + '\n')
wrangler(['d1', 'execute', DB_NAME, '--remote', '--file', 'data/chips.sql', '--yes'])
console.log(`✓ ${sql.length} rows updated (the site shows it within 5 minutes)`)
