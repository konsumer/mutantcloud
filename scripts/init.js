#!/usr/bin/env node
// npm run init: one-time setup (safe to run again, it skips what is already done)
//   1. log in to Cloudflare
//   2. create the D1 database + KV namespace, and put their ids in wrangler.jsonc
//   3. fill the database (everything the other hubs list, with GitHub details) and deploy
//   4. GitHub OAuth secrets (and optionally .dev.vars for logging in on `npm run start`)
// No GitHub token is stored: makers' CI publishes send their run's own short-lived token.
// Everything is remote: `npm run start` runs the worker locally against the same database and sessions.

import { createInterface } from 'node:readline/promises'
import { existsSync, writeFileSync } from 'node:fs'
import { wrangler, parseJson, readConfig, writeConfig, configIds, step, DB_NAME, PLACEHOLDER_DB, PLACEHOLDER_KV } from './wrangler.js'
import { deploy } from './deploy.js'
import { sync } from './sync.js'

const rl = createInterface({ input: process.stdin, output: process.stdout })
const ask = async (q, def = '') => (await rl.question(def ? `${q} [${def}] ` : `${q} `)).trim() || def
const yes = async (q, def = true) => /^y/i.test(await ask(`${q} (${def ? 'Y/n' : 'y/N'})`, def ? 'y' : 'n'))

async function main() {
  step('Cloudflare login')
  if (wrangler(['whoami', '--json'], { quiet: true, allowFail: true }) === null) {
    wrangler(['login'])
  } else {
    console.log('  already logged in')
  }

  step('D1 database')
  let config = readConfig()
  let { db, kv } = configIds(config)
  if (db && db !== PLACEHOLDER_DB) {
    console.log(`  using ${db}`)
  } else {
    let found = parseJson(wrangler(['d1', 'list', '--json'], { quiet: true })).find((d) => d.name === DB_NAME)
    if (!found) {
      wrangler(['d1', 'create', DB_NAME], { quiet: true })
      found = parseJson(wrangler(['d1', 'list', '--json'], { quiet: true })).find((d) => d.name === DB_NAME)
      console.log(`  created ${found.uuid}`)
    } else {
      console.log(`  found existing ${found.uuid}`)
    }
    db = found.uuid
    config = config.replace(/("database_id":\s*")[^"]+(")/, `$1${db}$2`)
    writeConfig(config)
  }

  step('KV namespace for sessions')
  if (kv && kv !== PLACEHOLDER_KV) {
    console.log(`  using ${kv}`)
  } else {
    // a name of its own, so it never picks up another project's namespace
    const title = `${DB_NAME}-sessions`
    const list = () => parseJson(wrangler(['kv', 'namespace', 'list'], { quiet: true }))
    let found = list().find((n) => n.title === title)
    if (!found) {
      wrangler(['kv', 'namespace', 'create', title], { quiet: true })
      found = list().find((n) => n.title === title)
      console.log(`  created ${found.id}`)
    } else {
      console.log(`  found existing ${found.id}`)
    }
    kv = found.id
    config = readConfig().replace(/("kv_namespaces":\s*\[\s*\{[^}]*"id":\s*")[^"]+(")/, `$1${kv}$2`)
    writeConfig(config)
  }

  // on an empty database, "what isn't listed yet" is everything; later runs only add what's new
  await sync()
  await deploy()

  step('GitHub login (OAuth app)')
  const have = parseJson(wrangler(['secret', 'list', '--format', 'json'], { quiet: true, allowFail: true }) || '[]').map((s) => s.name)
  if (have.includes('GITHUB_CLIENT_ID') && have.includes('GITHUB_CLIENT_SECRET') && !(await yes('  OAuth secrets are already set. Replace them?', false))) {
    console.log('  keeping them')
  } else {
    console.log(`
  Make a GitHub OAuth app: https://github.com/settings/applications/new
    Application name:            mutant.cloud
    Homepage URL:                https://mutant.cloud
    Authorization callback URL:  https://mutant.cloud/auth/callback
  Then "Generate a new client secret".
`)
    const id = await ask('  Client ID:')
    const secret = await ask('  Client secret:')
    if (id && secret) {
      wrangler(['secret', 'put', 'GITHUB_CLIENT_ID'], { input: id })
      wrangler(['secret', 'put', 'GITHUB_CLIENT_SECRET'], { input: secret })
      console.log('  saved')
    } else {
      console.log('  skipped (run `npm run init` again later)')
    }
  }

  step('Local login (optional)')
  if (existsSync(new URL('../.dev.vars', import.meta.url))) {
    console.log('  .dev.vars already exists')
  } else if (await yes('  Set up GitHub login for `npm run start` (local server) too? It needs a second OAuth app.', false)) {
    console.log(`
  Make another OAuth app: https://github.com/settings/applications/new
    Homepage URL:                http://localhost:8787
    Authorization callback URL:  http://localhost:8787/auth/callback
`)
    const id = await ask('  Client ID:')
    const secret = await ask('  Client secret:')
    if (id && secret) {
      writeFileSync(new URL('../.dev.vars', import.meta.url), `GITHUB_CLIENT_ID=${id}\nGITHUB_CLIENT_SECRET=${secret}\n`)
      console.log('  wrote .dev.vars (gitignored)')
    }
  }

  console.log(`
✓ Set up. From now on:
    npm run deploy   ship code changes (new versions arrive by themselves)
    npm run sync     add new listings from the other hubs, now and then
    npm run start    local server on http://localhost:8787, using the real database
`)
}

main()
  .catch((e) => {
    console.error(`\n✗ ${e.message}`)
    process.exitCode = 1
  })
  .finally(() => rl.close())
