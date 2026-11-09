#!/usr/bin/env node
// npm run og: renders scripts/og.html to public/og.png (the link preview picture) with headless Chrome.
// env: CHROME (the browser to use, if it isn't found)

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const ROOT = new URL('..', import.meta.url).pathname
const CANDIDATES = [process.env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean)
const chrome = CANDIDATES.find((c) => existsSync(c))
if (!chrome) {
  console.error('✗ no Chrome found: set CHROME to its path')
  process.exit(1)
}
// (the time budget lets the web font load before the picture is taken)
const r = spawnSync(chrome, ['--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--window-size=1200,630', '--virtual-time-budget=8000', `--screenshot=${ROOT}public/og.png`, `file://${ROOT}scripts/og.html`], { stdio: 'inherit' })
if (r.status !== 0) process.exit(r.status || 1)
console.log('✓ public/og.png')
