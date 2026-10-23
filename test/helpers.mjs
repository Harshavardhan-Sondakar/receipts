import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'receipts.mjs')

/** A fresh git repo with one commit. */
export function makeRepo(files = { 'README.md': 'hello\n' }) {
  const dir = mkdtempSync(join(tmpdir(), 'receipts-test-'))
  sh(dir, 'git', 'init', '-q')
  sh(dir, 'git', 'config', 'user.email', 'test@example.com')
  sh(dir, 'git', 'config', 'user.name', 'Test')
  sh(dir, 'git', 'config', 'commit.gpgsign', 'false')
  write(dir, files)
  sh(dir, 'git', 'add', '-A')
  sh(dir, 'git', 'commit', '-qm', 'init')
  return dir
}

export function write(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), content)
  }
}

export function sh(cwd, cmd, ...args) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8' })
}

/** Run the CLI like a hook or an agent would. */
export function cli(cwd, args, input = '') {
  const env = { ...process.env }
  delete env.CLAUDE_PROJECT_DIR
  delete env.RECEIPTS_DIR
  delete env.RECEIPTS_MODE
  // never hit npm or PyPI from tests
  env.RECEIPTS_OFFLINE = '1'
  const r = spawnSync('node', [CLI, ...args], { cwd, input, encoding: 'utf8', env })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

/** Claude Code style hook payloads. */
export function claude(dir, session = 's1') {
  const base = { session_id: session, transcript_path: '/tmp/t.jsonl', cwd: dir }
  const send = (payload) => cli(dir, ['hook'], JSON.stringify({ ...base, ...payload }))
  return {
    start: () => send({ hook_event_name: 'SessionStart', source: 'startup' }),
    edit: (file) =>
      send({
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: join(dir, file), old_string: 'a', new_string: 'b' },
        tool_response: {},
        tool_use_id: 'x',
      }),
    ok: (command, stdout = '') =>
      send({
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command },
        tool_response: { stdout, stderr: '', interrupted: false },
        tool_use_id: 'x',
      }),
    stop: (message = '', extra = {}) => send({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: message, ...extra }),
    fail: (command, error = 'Exit code 1') =>
      send({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'x', error }),
    send,
  }
}
