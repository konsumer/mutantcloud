#!/usr/bin/env node
// npm run sync: add firmware the other hubs list that isn't here yet (straight into the database, no deploy).
//   npm run sync -- --full   re-read everything instead (every listing, every repo on GitHub): rarely needed

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { wrangler, ghToken, step, ROOT, DB_NAME } from './wrangler.js'
import { checkConfig, migrate } from './deploy.js'

export async function sync({ full = false } = {}) {
  checkConfig()
  // tables first, in case this database is new
  migrate()

  step(full ? 'Collecting everything (other hubs + GitHub)' : 'Looking for new listings on the other hubs')
  const token = ghToken()
  if (!token) console.log('  (no GITHUB_TOKEN and `gh` is not logged in: GitHub details will be thin)')
  const r = spawnSync(process.execPath, ['scripts/collect.js', ...(full ? ['--full'] : [])], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...(token ? { GITHUB_TOKEN: token } : {}) } })
  if (r.status !== 0) throw new Error('collect failed')

  const sql = readFileSync(new URL('../data/auto.sql', import.meta.url), 'utf8').trim()
  if (!sql) return console.log('\n✓ nothing to add')
  step('Loading into the database')
  wrangler(['d1', 'execute', DB_NAME, '--remote', '--file', 'data/auto.sql', '--yes'])
  console.log('\n✓ synced (the site shows it within 5 minutes)')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  sync({ full: process.argv.includes('--full') }).catch((e) => {
    console.error(`\n✗ ${e.message}`)
    process.exit(1)
  })
}
