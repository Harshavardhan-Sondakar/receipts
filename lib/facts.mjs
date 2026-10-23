// @ts-check
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { changedFiles, diffHunks, git, showFile, snapshot } from './git.mjs'
import { currentTask, readLog } from './store.mjs'

/**
 * @typedef {import('./store.mjs').RunEvent} RunEvent
 * @typedef {import('./git.mjs').ChangedFile} ChangedFile
 * @typedef {{ cmd: string, kinds: string[], ok: boolean | null, code?: number, note?: string, counts?: { passed?: number, failed?: number }, stale: boolean | null, times: number }} Check
 * @typedef {{
 *   recorded: boolean,
 *   late: boolean,
 *   git: boolean,
 *   files: ChangedFile[],
 *   checks: Check[],
 *   notRun: string[],
 *   flags: string[],
 *   areas: string[],
 *   tree: string | null,
 * }} Facts
 */

const TEST_FILE = /(^|\/)(tests?|__tests__|specs?|e2e)\/|\.(test|spec|e2e)\.[cm]?[jt]sx?$|_test\.(go|py|rb|exs?)$|(^|\/)test_[^/]*\.py$|Tests?\.(cs|java|kt|swift)$|_spec\.rb$/i
const CODE_FILE = /\.(c|cc|cpp|cs|dart|ex|exs|go|h|hpp|java|jsx?|kt|kts|m|mjs|cjs|mts|cts|php|py|rb|rs|scala|svelte|swift|tsx?|vue)$/i

// paths where a small change can matter a lot
const SENSITIVE = [
  [/(^|\/)\.env(\.|$)/i, 'env file'],
  [/(^|\/)\.github\/workflows\/|(^|\/)\.gitlab-ci\.ya?ml$|(^|\/)\.circleci\/|(^|\/)Jenkinsfile$|(^|\/)azure-pipelines\.ya?ml$/i, 'CI config'],
  [/(^|\/)(Dockerfile|docker-compose[^/]*\.ya?ml|compose\.ya?ml)$/i, 'container config'],
  [/\.tf$|(^|\/)(k8s|kubernetes|helm|charts)\//i, 'infrastructure'],
  [/(^|\/)(migrations?|migrate)\/|\.sql$/i, 'database migration'],
  [/(^|[/._-])(auth|authn|authz|authentication|authorization|authorize|login|logout|session|sessions|passwords?|permissions?|roles?|rbac|acl|crypto|security|secrets?|tokens?|oauth|jwt|csrf|cors)([/._-]|$)/i, 'auth / security'],
]

// silenced checks and skipped tests in added lines
const SILENCED = [
  [/\b(?:it|test|describe|context|suite)\.only\s*\(|\bf(?:it|describe)\s*\(/, 'focused test (.only), other tests are skipped'],
  [/\b(?:it|test|describe|context|suite)\.skip\s*\(|\bx(?:it|describe|test)\s*\(|@pytest\.mark\.skip|@unittest\.skip|\bt\.Skip(?:Now|f)?\(|#\[ignore\]|@Disabled\b|@Ignore\b/, 'skipped test'],
  [/@ts-(?:ignore|nocheck)\b|@ts-expect-error\b/, 'type error silenced'],
  [/eslint-disable|biome-ignore|oxlint-disable|#\s*type:\s*ignore|#\s*noqa\b|#\s*pylint:\s*disable|\/\/\s*nolint\b|#\[allow\(/, 'lint rule silenced'],
]

const RISKY_COMMANDS = [
  [/\bgit\s+push\b.*\s(?:--force|-f|--force-with-lease)\b/, 'force push'],
  [/\bgit\s+reset\s+--hard\b/, 'git reset --hard'],
  [/\bgit\s+clean\s+-\w*f/, 'git clean'],
  [/\bgit\s+(?:checkout|restore)\s+(?:--\s+)?\.(?:\s|$)/, 'discarded local changes'],
  [/\s--no-verify\b/, 'skipped git hooks (--no-verify)'],
  [/\brm\s+-\w*r\w*f?\s+(?!(?:\.\/)?(?:node_modules|dist|build|coverage|\.next|target|__pycache__|tmp)\b)/, 'recursive delete'],
  [/\b(?:npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b/, 'published a package'],
  [/\b(?:drop\s+(?:table|database)|truncate\s+table)\b/i, 'dropped data'],
  [/\b(?:terraform|tofu)\s+(?:apply|destroy)\b|\bkubectl\s+(?:delete|apply)\b|\bhelm\s+(?:install|upgrade|uninstall)\b/, 'changed live infrastructure'],
  [/\bchmod\s+(?:-R\s+)?777\b/, 'chmod 777'],
]

/**
 * Collect everything we know about the current task without asking the AI anything.
 * @param {string} root
 * @returns {Facts}
 */
export function collectFacts(root) {
  const { base, events } = currentTask(readLog(root))
  const recorded = base !== null
  const late = Boolean(base && 'late' in base && base.late)
  const tree = snapshot(root)
  // with nothing recorded we can still compare with the last commit
  const baseTree = base?.tree ?? (tree ? git(root, ['rev-parse', '--verify', '-q', 'HEAD^{tree}'])?.trim() || null : null)
  const isGit = tree !== null && Boolean(baseTree)

  /** @type {ChangedFile[]} */
  let files = []
  /** @type {ReturnType<typeof diffHunks>} */
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
  const lastEdit = Math.max(0, ...events.filter((e) => e.t === 'edit').map((e) => e.at))

  // the last run of each check command decides, earlier runs are just history
  /** @type {Map<string, Check>} */
  const byCmd = new Map()
  for (const run of runs) {
    if (!run.kinds.length) continue
    const stale = run.tree && tree ? run.tree !== tree : lastEdit ? run.at < lastEdit : null
    const prev = byCmd.get(run.cmd)
    byCmd.set(run.cmd, {
      cmd: run.cmd,
      kinds: run.kinds,
      ok: run.ok,
      code: run.code,
      note: run.note,
      counts: run.counts,
      stale,
      times: (prev?.times ?? 0) + 1,
    })
  }
  const checks = [...byCmd.values()]

  const ranKinds = new Set(checks.flatMap((c) => c.kinds))
  const notRun = files.length ? expectedChecks(root).filter((k) => !ranKinds.has(k.kind)).map((k) => k.cmd) : []

  return {
    recorded,
    late,
    git: isGit,
    files,
    checks,
    notRun,
    flags: [...diffFlags(root, baseTree, tree, files, hunks), ...commandFlags(runs)],
    areas: biggestAreas(hunks),
    tree,
  }
}

/**
 * Checks this project seems to have, so we can say which ones never ran.
 * @param {string} root
 * @returns {{ kind: string, cmd: string }[]}
 */
function expectedChecks(root) {
  /** @type {{ kind: string, cmd: string }[]} */
  const out = []
  const pkgFile = join(root, 'package.json')
  if (existsSync(pkgFile)) {
    try {
      const scripts = JSON.parse(readFileSync(pkgFile, 'utf8')).scripts ?? {}
      const pm = existsSync(join(root, 'pnpm-lock.yaml'))
        ? 'pnpm'
        : existsSync(join(root, 'yarn.lock'))
          ? 'yarn'
          : existsSync(join(root, 'bun.lock')) || existsSync(join(root, 'bun.lockb'))
            ? 'bun'
            : 'npm'
      const run = (/** @type {string} */ s) => (pm === 'npm' && s === 'test' ? 'npm test' : `${pm} run ${s}`)
      if (scripts.test && !/no test specified/.test(scripts.test)) out.push({ kind: 'test', cmd: run('test') })
      const tc = ['typecheck', 'type-check', 'check-types', 'tsc', 'types'].find((s) => scripts[s])
      if (tc) out.push({ kind: 'typecheck', cmd: run(tc) })
      if (scripts.lint) out.push({ kind: 'lint', cmd: run('lint') })
    } catch {}
    return out
  }
  const has = (/** @type {string} */ f) => existsSync(join(root, f))
  if (has('Cargo.toml')) out.push({ kind: 'test', cmd: 'cargo test' })
  else if (has('go.mod')) out.push({ kind: 'test', cmd: 'go test ./...' })
  else if (has('pytest.ini') || has('pyproject.toml') || has('setup.cfg') || has('tox.ini')) out.push({ kind: 'test', cmd: 'pytest' })
  return out
}

/**
 * @param {string} root
 * @param {string | null} from
 * @param {string | null} to
 * @param {ChangedFile[]} files
 * @param {ReturnType<typeof diffHunks>} hunks
 */
function diffFlags(root, from, to, files, hunks) {
  /** @type {string[]} */
  const flags = []

  // skipped tests and silenced checks in new lines
  /** @type {Map<string, string[]>} */
  const silenced = new Map()
  for (const h of hunks) {
    for (const a of h.added) {
      for (const [re, label] of /** @type {[RegExp, string][]} */ (SILENCED)) {
        if (re.test(a.text)) {
          const list = silenced.get(label) ?? []
          list.push(`${h.file}:${a.line}`)
          silenced.set(label, list)
        }
      }
    }
  }
  for (const [label, where] of silenced) flags.push(`${label}: ${listShort(where, 3)}`)

  const deletedTests = files.filter((f) => f.status === 'D' && TEST_FILE.test(f.path)).map((f) => f.path)
  if (deletedTests.length) flags.push(`test file deleted: ${listShort(deletedTests, 3)}`)

  const removedTests = files.filter((f) => f.status === 'M' && TEST_FILE.test(f.path) && f.removed > f.added + 10)
  if (removedTests.length) flags.push(`many test lines removed: ${listShort(removedTests.map((f) => `${f.path} (-${f.removed})`), 3)}`)

  const sensitive = new Map()
  for (const f of files) {
    for (const [re, label] of /** @type {[RegExp, string][]} */ (SENSITIVE)) {
      if (re.test(f.path)) {
        sensitive.set(label, [...(sensitive.get(label) ?? []), f.path])
        break
      }
    }
  }
  for (const [label, paths] of sensitive) flags.push(`${label} changed: ${listShort(paths, 3)}`)

  if (from && to) {
    const deps = newDependencies(root, from, to, files)
    if (deps.length) flags.push(`new dependency: ${listShort(deps, 5)}`)
  }

  const code = files.filter((f) => f.status !== 'D' && CODE_FILE.test(f.path) && !TEST_FILE.test(f.path))
  const tests = files.filter((f) => TEST_FILE.test(f.path))
  if (code.length && !tests.length) flags.push('code changed but no test files changed')

  return flags
}

/**
 * @param {string} root
 * @param {string} from
 * @param {string} to
 * @param {ChangedFile[]} files
 */
function newDependencies(root, from, to, files) {
  /** @type {string[]} */
  const added = []
  for (const f of files) {
    const name = f.path.split('/').pop()
    if (name === 'package.json') {
      const before = parseDeps(showFile(root, from, f.oldPath ?? f.path))
      const after = parseDeps(showFile(root, to, f.path))
      for (const dep of after) if (!before.has(dep)) added.push(dep)
    } else if (name && /^requirements[\w.-]*\.txt$/.test(name)) {
      const before = new Set(depLines(showFile(root, from, f.oldPath ?? f.path)))
      for (const dep of depLines(showFile(root, to, f.path))) if (!before.has(dep)) added.push(dep)
    } else if (name === 'go.mod') {
      const re = /^\s*(?:require\s+)?([\w.-]+\.[\w./-]+)\s+v/gm
      const before = new Set([...(showFile(root, from, f.path) ?? '').matchAll(re)].map((m) => m[1]))
      for (const m of (showFile(root, to, f.path) ?? '').matchAll(re)) if (!before.has(m[1])) added.push(m[1])
    }
  }
  return [...new Set(added)]
}

/** @param {string | null} text */
function parseDeps(text) {
  try {
    const pkg = JSON.parse(text ?? '{}')
    return new Set(
      ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap((k) => Object.keys(pkg[k] ?? {})),
    )
  } catch {
    return new Set()
  }
}

/** @param {string | null} text */
function depLines(text) {
  return (text ?? '')
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim())
    .filter((l) => l && !l.startsWith('-'))
    .map((l) => l.split(/[\s=<>!~;[]/)[0].toLowerCase())
}

/** @param {RunEvent[]} runs */
function commandFlags(runs) {
  /** @type {string[]} */
  const flags = []
  for (const run of runs) {
    for (const [re, label] of /** @type {[RegExp, string][]} */ (RISKY_COMMANDS)) {
      if (re.test(run.cmd)) {
        flags.push(`ran a risky command (${label}): ${run.cmd}`)
        break
      }
    }
  }
  return [...new Set(flags)].slice(0, 5)
}

/**
 * The largest changed regions, so the agent can point reviewers at real line numbers.
 * @param {ReturnType<typeof diffHunks>} hunks
 */
function biggestAreas(hunks) {
  // join hunks that are close to each other in the same file
  /** @type {{ file: string, start: number, end: number, added: number }[]} */
  const areas = []
  for (const h of hunks) {
    if (!h.count) continue
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
    .filter((a) => !/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lock|Cargo\.lock|go\.sum|poetry\.lock)$/.test(a.file))
    .sort((a, b) => b.added - a.added)
    .slice(0, 5)
    .map((a) => `${a.file}:${a.start === a.end ? a.start : `${a.start}-${a.end}`}`)
}

/**
 * @param {string[]} items
 * @param {number} max
 */
function listShort(items, max) {
  return items.length > max ? `${items.slice(0, max).join(', ')} (+${items.length - max} more)` : items.join(', ')
}
