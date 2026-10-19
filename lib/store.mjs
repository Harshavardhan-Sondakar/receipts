// @ts-check
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { repoRoot } from './git.mjs'

/**
 * @typedef {{ t: 'start', at: number, session: string, tree: string | null, late?: boolean }} StartEvent
 * @typedef {{ t: 'run', at: number, session: string, cmd: string, kinds: string[], ok: boolean | null, code?: number, note?: string, counts?: { passed?: number, failed?: number }, tree?: string | null }} RunEvent
 * @typedef {{ t: 'edit', at: number, session: string, file: string }} EditEvent
 * @typedef {{ t: 'receipt', at: number, session: string, tree: string | null, file: string }} ReceiptEvent
 * @typedef {StartEvent | RunEvent | EditEvent | ReceiptEvent} LogEvent
 */

const MAX_LOG_BYTES = 2 * 1024 * 1024

/**
 * The project folder: the git root if there is one, otherwise the given folder.
 * @param {string} [cwd]
 */
export function projectRoot(cwd = process.cwd()) {
  const dir = process.env.RECEIPTS_DIR || process.env.CLAUDE_PROJECT_DIR || cwd
  const git = repoRoot(dir)
  if (git) return git
  try {
    return realpathSync(resolve(dir))
  } catch {
    return resolve(dir)
  }
}

/** @param {string} root */
export function receiptsDir(root) {
  const dir = join(root, '.receipts')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    // keeps the folder out of git without touching the project's own .gitignore
    writeFileSync(join(dir, '.gitignore'), '*\n')
  }
  return dir
}

/** @param {string} session */
function markerName(session) {
  return `started-${session.replace(/[^\w.-]/g, '_').slice(0, 80)}`
}

/**
 * @param {string} root
 * @param {string} session
 */
export function markStarted(root, session) {
  writeFileSync(join(receiptsDir(root), markerName(session)), '')
}

/**
 * @param {string} root
 * @param {string} session
 */
export function wasStarted(root, session) {
  return existsSync(join(root, '.receipts', markerName(session)))
}

/**
 * @param {string} root
 * @param {LogEvent} event
 */
export function append(root, event) {
  const file = join(receiptsDir(root), 'log.jsonl')
  appendFileSync(file, `${JSON.stringify(event)}\n`)
  try {
    if (statSync(file).size > MAX_LOG_BYTES) {
      // keep the newest half, an old task nobody made a receipt for isn't worth keeping
      const lines = readFileSync(file, 'utf8').trimEnd().split('\n')
      writeFileSync(file, `${lines.slice(Math.floor(lines.length / 2)).join('\n')}\n`)
    }
  } catch {}
}

/**
 * @param {string} root
 * @returns {LogEvent[]}
 */
export function readLog(root) {
  const file = join(root, '.receipts', 'log.jsonl')
  if (!existsSync(file)) return []
  /** @type {LogEvent[]} */
  const events = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // a half written line from a crash, skip it
    }
  }
  return events
}

/**
 * Events of the current task: the latest session, after its last receipt
 * (or its start). Also returns the baseline tree to compare against.
 * @param {LogEvent[]} events
 */
export function currentTask(events) {
  const last = events.findLast((e) => e.t !== 'receipt') ?? events.at(-1)
  if (!last) return { session: null, base: null, events: [] }
  const session = last.session
  const mine = events.filter((e) => e.session === session)
  const startIndex = mine.findLastIndex((e) => e.t === 'start' || e.t === 'receipt')
  const base = startIndex === -1 ? null : /** @type {StartEvent | ReceiptEvent} */ (mine[startIndex])
  return { session, base, events: mine.slice(startIndex + 1) }
}
