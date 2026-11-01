#!/usr/bin/env node
// npm run poster: render design/poster.html to public/og.png (1200x630) with headless Chrome
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const ROOT = new URL('..', import.meta.url).pathname
const chrome = [process.env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', 'google-chrome', 'chromium', 'chromium-browser'].find((c) => c && (c.startsWith('/') ? existsSync(c) : spawnSync('which', [c]).status === 0))
if (!chrome) {
  console.error('✗ no Chrome found: set CHROME=/path/to/chrome')
  process.exit(1)
}
const r = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--window-size=1200,630', '--virtual-time-budget=8000', `--screenshot=${ROOT}public/og.png`, `file://${ROOT}design/poster.html`], { stdio: 'ignore' })
if (r.status !== 0) {
  console.error('✗ Chrome failed')
  process.exit(1)
}
console.log('✓ public/og.png')
