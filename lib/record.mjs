// @ts-check
import { realpathSync } from 'node:fs'
import { isAbsolute, relative } from 'node:path'
import { checkResultHidden, checkKinds, maskSecrets, shortCommand, testCounts } from './commands.mjs'
import { git, snapshot } from './git.mjs'
import { append, markStarted, projectRoot, wasStarted } from './store.mjs'

/**
 * Turn one hook payload into a log event and save it.
 * Works with the payloads of Claude Code, Codex and Cursor.
 * Never throws and never prints, so it can't get in the agent's way.
 * @param {any} input parsed JSON from the hook's stdin
 */
export function record(input) {
  try {
    recordUnsafe(input)
  } catch (err) {
    if (process.env.RECEIPTS_DEBUG) console.error(err)
  }
}

/** @param {any} input */
function recordUnsafe(input) {
  if (!input || typeof input !== 'object') return
  const event = input.hook_event_name ?? ''
  const cwd = typeof input.cwd === 'string' ? input.cwd : input.workspace_roots?.[0]
  const root = projectRoot(cwd)
  const session = String(input.session_id ?? input.conversation_id ?? 'default')
  const at = Date.now()

  if (event === 'SessionStart' || event === 'sessionStart') {
    append(root, { t: 'start', at, session, tree: snapshot(root) })
    markStarted(root, session)
    return
  }

  ensureStarted(root, session, at)

  const tool = input.tool_name ?? ''

  // shell commands
  const command =
    input.tool_input?.command ?? (event === 'afterShellExecution' || event === 'beforeShellExecution' ? input.command : undefined)
  if (typeof command === 'string' && (tool === 'Bash' || tool === 'shell' || tool === 'exec_command' || !tool)) {
    if (event === 'beforeShellExecution') return
    let result = commandResult(event, input)
    const kinds = checkKinds(command)
    // `npm test | tail` reports tail's exit code, so only trust the test summary
    if (result.ok === true && checkResultHidden(command)) {
      result = result.counts
        ? { ok: !result.counts.failed, counts: result.counts }
        : { ok: null, note: 'exit code hidden by a later command' }
    }
    // if the output has a test summary, it was a test run, however it was started
    if (!kinds.includes('test') && result.counts) kinds.push('test')
    append(root, {
      t: 'run',
      at,
      session,
      cmd: shortCommand(maskSecrets(command)),
      kinds,
      ...result,
      // a snapshot lets us tell later if the code changed after this check ran
      ...(kinds.length ? { tree: snapshot(root) } : {}),
    })
    return
  }

  // file edits
  for (const file of editedFiles(event, tool, input)) {
    append(root, { t: 'edit', at, session, file: isAbsolute(file) ? relative(root, realPath(file)) : file })
  }
}

/**
 * Pass/fail of a shell command, from whatever the agent gives us.
 * @param {string} event
 * @param {any} input
 * @returns {{ ok: boolean | null, code?: number, note?: string, counts?: { passed?: number, failed?: number } }}
 */
function commandResult(event, input) {
  const res = input.tool_response

  // Claude Code: a failed command comes as its own event with an error message
  if (event === 'PostToolUseFailure') {
    if (input.is_interrupt) return { ok: null, note: 'stopped' }
    const error = String(input.error ?? '')
    const code = /exit code (\d+)/i.exec(error)?.[1]
    const counts = testCounts(error)
    return { ok: false, ...(code ? { code: Number(code) } : {}), ...(counts ? { counts } : {}) }
  }

  if (res && typeof res === 'object') {
    if (res.backgroundTaskId) return { ok: null, note: 'background' }
    if (res.interrupted) return { ok: null, note: 'stopped' }
    const out = [res.stdout, res.stderr, res.output, res.aggregated_output].filter((x) => typeof x === 'string').join('\n')
    const counts = testCounts(out)
    // Codex style
    const exit = res.exit_code ?? res.exitCode
    if (typeof exit === 'number') return { ok: exit === 0, ...(exit ? { code: exit } : {}), ...(counts ? { counts } : {}) }
    // Claude Code: PostToolUse only fires when the command succeeded
    if (event === 'PostToolUse') return { ok: true, ...(counts ? { counts } : {}) }
  }

  // Cursor gives the output but no exit code, so we can only say it ran
  if (event === 'afterShellExecution') {
    const counts = testCounts(String(input.output ?? ''))
    if (counts) return { ok: !counts.failed, counts }
    return { ok: null, note: 'result unknown' }
  }
  return { ok: null, note: 'result unknown' }
}

/**
 * @param {string} event
 * @param {string} tool
 * @param {any} input
 * @returns {string[]}
 */
function editedFiles(event, tool, input) {
  if (event === 'afterFileEdit' && typeof input.file_path === 'string') return [input.file_path]
  const ti = input.tool_input ?? {}
  if (['Edit', 'Write', 'MultiEdit'].includes(tool) && typeof ti.file_path === 'string') return [ti.file_path]
  if (tool === 'NotebookEdit' && typeof ti.notebook_path === 'string') return [ti.notebook_path]
  if (tool === 'apply_patch') {
    // Codex patches list files as "*** Update File: path"
    const patch = String(ti.input ?? ti.patch ?? ti.command ?? '')
    return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim())
  }
  return []
}

/**
 * If the session started before the plugin was installed (or the agent has no
 * start hook), begin the task now and compare against the last commit.
 * @param {string} root
 * @param {string} session
 * @param {number} at
 */
function ensureStarted(root, session, at) {
  if (wasStarted(root, session)) return
  const head = git(root, ['rev-parse', '--verify', '-q', 'HEAD^{tree}'])?.trim() || null
  append(root, { t: 'start', at, session, tree: head, late: true })
  markStarted(root, session)
}

// git gives real paths, so resolve symlinks (macOS /var -> /private/var) before comparing
/** @param {string} file */
function realPath(file) {
  try {
    return realpathSync(file)
  } catch {
    return file
  }
}
