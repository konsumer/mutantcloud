// small helpers for running wrangler (and gh) from the setup/deploy scripts
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

export const ROOT = new URL('..', import.meta.url).pathname
const BIN = new URL('../node_modules/.bin/wrangler', import.meta.url).pathname
export const CONFIG = new URL('../wrangler.jsonc', import.meta.url).pathname

export const DB_NAME = 'mutantcloud'
export const PLACEHOLDER_DB = '00000000-0000-0000-0000-000000000000'
export const PLACEHOLDER_KV = '00000000000000000000000000000000'

// with more than one Cloudflare account, some wrangler commands (d1 in non-interactive mode) ignore
// wrangler.jsonc's account_id unless it's in the environment too
function accountEnv() {
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return {}
  const id = readFileSync(CONFIG, 'utf8').match(/"account_id":\s*"([^"]+)"/)?.[1]
  return id ? { CLOUDFLARE_ACCOUNT_ID: id } : {}
}

// run wrangler; quiet returns stdout, otherwise output goes to the terminal
export function wrangler(args, { quiet = false, input, env = {}, allowFail = false } = {}) {
  const r = spawnSync(BIN, args, {
    cwd: ROOT,
    input,
    encoding: 'utf8',
    env: { ...process.env, ...accountEnv(), ...env },
    stdio: quiet || input !== undefined ? ['pipe', 'pipe', 'pipe'] : 'inherit'
  })
  if (r.status !== 0 && !allowFail) {
    if (quiet) process.stderr.write(r.stderr || r.stdout || '')
    throw new Error(`wrangler ${args.join(' ')} failed`)
  }
  return r.status === 0 ? r.stdout || '' : null
}

// the JSON part of wrangler's output (it sometimes prints a banner first)
export function parseJson(out) {
  const i = out.search(/^[[{]/m)
  return JSON.parse(out.slice(i))
}

export function ghToken() {
  if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) return process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  const r = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : null
}

export const readConfig = () => readFileSync(CONFIG, 'utf8')
export const writeConfig = (s) => writeFileSync(CONFIG, s)
export const configIds = (s = readConfig()) => ({
  db: s.match(/"database_id":\s*"([^"]+)"/)?.[1],
  kv: s.match(/"kv_namespaces":\s*\[\s*\{[^}]*"id":\s*"([^"]+)"/)?.[1]
})

export const step = (s) => console.log(`\n\x1b[1m\x1b[35m▸ ${s}\x1b[0m`)
