// @ts-check
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from './config.mjs'
import { changedFiles, diffHunks, git, snapshot } from './git.mjs'
import { isDoc, isNoise } from './paths.mjs'
import { currentTask, readLog } from './store.mjs'

/**
 * @typedef {import('./store.mjs').RunEvent} RunEvent
 * @typedef {import('./store.mjs').EditEvent} EditEvent
 * @typedef {import('./git.mjs').ChangedFile} ChangedFile
 * @typedef {import('./git.mjs').Hunk} Hunk
 * @typedef {import('./config.mjs').Config} Config
 * @typedef {{ cmd: string, kinds: string[], ok: boolean | null, code?: number, note?: string, counts?: { passed?: number, failed?: number }, stale: boolean | null, at: number, times: number }} Check
 * @typedef {{ kind: string, cmd: string }} Expected
 * @typedef {{
 *   root: string,
 *   recorded: boolean,
 *   late: boolean,
 *   git: boolean,
 *   tree: string | null,
 *   baseTree: string | null,
 *   files: ChangedFile[],
 *   hunks: Hunk[],
 *   runs: RunEvent[],
 *   edits: EditEvent[],
 *   checks: Check[],
 *   expected: Expected[],
 *   notRun: string[],
 *   codeChanged: boolean,
 *   areas: string[],
 *   config: Config,
 * }} Facts
 */

/**
 * Collect everything we know about the current task without asking the AI anything.
 * @param {string} root
 * @param {{ base?: string }} [opts] compare with this git ref instead of the start of the task
 * @returns {Facts}
 */
export function collectFacts(root, opts = {}) {
  const config = loadConfig(root)
  const { base, events } = currentTask(readLog(root))
  const recorded = base !== null
  const late = Boolean(base && 'late' in base && base.late)
  const tree = snapshot(root)
  // with nothing recorded we can still compare with the last commit
  const ref = opts.base ? `${opts.base}^{tree}` : 'HEAD^{tree}'
  const fallback = tree ? git(root, ['rev-parse', '--verify', '-q', ref])?.trim() || null : null
  if (opts.base && !fallback) throw new Error(`receipts: can't find git ref "${opts.base}"`)
  const baseTree = opts.base ? fallback : (base?.tree ?? fallback)
  const isGit = tree !== null && Boolean(baseTree)

  /** @type {ChangedFile[]} */
  let files = []
  /** @type {Hunk[]} */
  let hunks = []
  if (isGit && baseTree && tree) {
    files = changedFiles(root, baseTree, tree)
    hunks = diffHunks(root, baseTree, tree)
  } else {
    // no git: we only know which files the agent edited through its edit tool
    const seen = new Set()
    for (const e of events) if (e.t === 'edit') seen.add(e.file)
    files = [...seen].map((path) => ({ path, status: 'M', added: 0, removed: 0 }))
  }

  const runs = /** @type {RunEvent[]} */ (events.filter((e) => e.t === 'run'))
  const edits = /** @type {EditEvent[]} */ (events.filter((e) => e.t === 'edit'))

  // the last run of each check command decides, earlier runs are just history
  /** @type {Map<string, Check>} */
  const byCmd = new Map()
  /** @type {Map<string, boolean | null>} */
  const staleCache = new Map()
  for (const run of runs) {
    if (!run.kinds.length) continue
    const prev = byCmd.get(run.cmd)
    byCmd.set(run.cmd, {
      cmd: run.cmd,
      kinds: run.kinds,
      ok: run.ok,
      code: run.code,
      note: run.note,
      counts: run.counts,
      stale: staleness(root, run, tree, edits, staleCache),
      at: run.at,
      times: (prev?.times ?? 0) + 1,
    })
  }
  const checks = [...byCmd.values()]

  const expected = expectedChecks(root, config)
  const ranKinds = new Set(checks.flatMap((c) => c.kinds))
  const codeChanged = files.some((f) => !isDoc(f.path) && !isNoise(f.path))
  const notRun = codeChanged ? expected.filter((k) => !ranKinds.has(k.kind)).map((k) => k.cmd) : []

  return {
    root,
    recorded,
    late,
    git: isGit,
    tree,
    baseTree,
    files,
    hunks,
    runs,
    edits,
    checks,
    expected,
    notRun,
    codeChanged,
    areas: biggestAreas(hunks),
    config,
  }
}

/**
 * Did code change after this check ran? Docs-only edits don't count.
 * @param {string} root
 * @param {RunEvent} run
 * @param {string | null} tree
 * @param {EditEvent[]} edits
 * @param {Map<string, boolean | null>} cache
 * @returns {boolean | null}
 */
function staleness(root, run, tree, edits, cache) {
  if (run.tree && tree) {
    if (run.tree === tree) return false
    const cached = cache.get(run.tree)
    if (cached !== undefined) return cached
    const changed = changedFiles(root, run.tree, tree)
    const stale = changed.some((f) => !isDoc(f.path))
    cache.set(run.tree, stale)
    return stale
  }
  const later = edits.filter((e) => e.at > run.at && !isDoc(e.file))
  return edits.length ? later.length > 0 : null
}

/**
 * Checks this project seems to have, so we can say which ones never ran.
 * @param {string} root
 * @param {Config} config
 * @returns {Expected[]}
 */
export function expectedChecks(root, config) {
  /** @type {Expected[]} */
  const out = []
  const has = (/** @type {string} */ f) => existsSync(join(root, f))
  const pkgFile = join(root, 'package.json')
  if (has('package.json')) {
    try {
      const scripts = JSON.parse(readFileSync(pkgFile, 'utf8')).scripts ?? {}
      const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lock') || has('bun.lockb') ? 'bun' : 'npm'
      const run = (/** @type {string} */ s) => (pm === 'npm' && s === 'test' ? 'npm test' : `${pm} run ${s}`)
      if (scripts.test && !/no test specified/.test(scripts.test)) out.push({ kind: 'test', cmd: run('test') })
      const tc = ['typecheck', 'type-check', 'check-types', 'tsc', 'types'].find((s) => scripts[s])
      if (tc) out.push({ kind: 'typecheck', cmd: run(tc) })
      if (scripts.lint) out.push({ kind: 'lint', cmd: run('lint') })
    } catch {}
  } else if (has('Cargo.toml')) {
    out.push({ kind: 'test', cmd: 'cargo test' })
  } else if (has('go.mod')) {
    out.push({ kind: 'test', cmd: 'go test ./...' }, { kind: 'typecheck', cmd: 'go vet ./...' })
  } else if (has('pytest.ini') || has('pyproject.toml') || has('setup.cfg') || has('tox.ini') || has('conftest.py')) {
    out.push({ kind: 'test', cmd: 'pytest' })
  }
  if (!out.some((e) => e.kind === 'test') && has('Makefile')) {
    try {
      if (/^test:/m.test(readFileSync(join(root, 'Makefile'), 'utf8'))) out.push({ kind: 'test', cmd: 'make test' })
    } catch {}
  }
  // the config wins: it's how people add their own commands
  for (const [kind, cmd] of Object.entries(config.commands)) {
    const i = out.findIndex((e) => e.kind === kind)
    if (i === -1) out.push({ kind, cmd })
    else out[i] = { kind, cmd }
  }
  return out.filter((e) => config.require.includes(e.kind) || config.commands[e.kind])
}

/**
 * The largest changed regions, so the agent can point reviewers at real line numbers.
 * @param {Hunk[]} hunks
 */
function biggestAreas(hunks) {
  /** @type {{ file: string, start: number, end: number, added: number }[]} */
  const areas = []
  for (const h of hunks) {
    if (!h.count || isNoise(h.file)) continue
    const end = h.start + h.count - 1
    const prev = areas.at(-1)
    if (prev && prev.file === h.file && h.start - prev.end <= 5) {
      prev.end = Math.max(prev.end, end)
      prev.added += h.added.length
    } else {
      areas.push({ file: h.file, start: h.start, end, added: h.added.length })
    }
  }
  return areas
    .sort((a, b) => b.added - a.added)
    .slice(0, 5)
    .map((a) => `${a.file}:${a.start === a.end ? a.start : `${a.start}-${a.end}`}`)
}
