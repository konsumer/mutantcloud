#!/usr/bin/env node
// npm run deploy: ship the code (database migrations, then the worker). No data collecting:
// new versions come from the worker's own release watcher and makers' CI; new listings from `npm run sync`.

import { wrangler, configIds, step, DB_NAME, PLACEHOLDER_DB, PLACEHOLDER_KV } from './wrangler.js'

export function checkConfig() {
  const ids = configIds()
  if (!ids.db || ids.db === PLACEHOLDER_DB || !ids.kv || ids.kv === PLACEHOLDER_KV) {
    throw new Error('wrangler.jsonc has no database/KV ids yet: run `npm run init` first')
  }
}

export function migrate() {
  step('Applying database migrations')
  wrangler(['d1', 'migrations', 'apply', DB_NAME, '--remote'], { env: { CI: '1' } })
}

export async function deploy() {
  checkConfig()
  migrate()
  step('Deploying worker')
  wrangler(['deploy'])
}

if (import.meta.url === `file://${process.argv[1]}`) {
  deploy()
    .then(() => console.log('\n✓ deployed: https://mutant.cloud'))
    .catch((e) => {
      console.error(`\n✗ ${e.message}`)
      process.exit(1)
    })
}
