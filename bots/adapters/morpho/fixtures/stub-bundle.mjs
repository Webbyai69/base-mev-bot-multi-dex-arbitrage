// Test stub standing in for blue-liquidation's dist/src/index.js: replays recorded log lines through
// console.error (as the upstream logger does) and reports which variables it was given (names only).
import { readFileSync } from 'node:fs'
const lines = readFileSync(new URL('./detect-sample.log', import.meta.url), 'utf8').split('\n')
for (const l of lines) if (l.trim()) console.error(l)
console.error(JSON.stringify({ level: 'info', event: 'stub.env', names: Object.keys(process.env).sort(), detection: process.env.ALLOW_DETECTION_ONLY, lifi: process.env.ENABLE_LIFI, chain: process.env.CHAIN_ID }))
