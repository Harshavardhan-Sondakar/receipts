import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { analyze } from '../lib/analyze.mjs'
import { collectFacts } from '../lib/facts.mjs'
import { claude, cli, makeRepo, sh, write } from './helpers.mjs'

const PKG = JSON.stringify({ name: 'app', scripts: { test: 'vitest run' } })
const facts = (dir) => cli(dir, ['facts']).out
const parse = (out) => (out ? JSON.parse(out) : null)

/** a repo with a test script, a session started, and one code change */
function started(files = {}) {
  const dir = makeRepo({ 'package.json': PKG, 'src/a.js': 'export const a = 1\n', ...files })
  const agent = claude(dir)
  agent.start()
  return { dir, agent }
}

describe('gate: not done until verified', () => {
  it('sends the agent back when tests never ran, then lets it stop', () => {
    const { dir, agent } = started()
    write(dir, { 'src/a.js': 'export const a = 2\n' })
    const first = parse(agent.stop('Done, changed a to 2.').out)
    assert.equal(first.decision, 'block')
    assert.match(first.reason, /Tests never ran on these changes\. Run `npm test`\./)

    // the agent explains instead of running them: same problem doesn't block twice
    const second = parse(agent.stop('The user asked me not to run tests.', { stop_hook_active: true }).out)
    assert.equal(second.decision, undefined)
    assert.match(second.systemMessage, /tests ⚠️ not run/)
  })

  it('stays quiet once everything is verified, and shows a summary to the user', () => {
    const { dir, agent } = started()
    write(dir, { 'src/a.js': 'export const a = 2\n', 'test/a.test.js': 'expect(a).toBe(2)\n' })
    agent.ok('npm test', ' Tests  3 passed (3)')
    const out = parse(agent.stop('All tests pass.').out)
    assert.equal(out.decision, undefined)
    assert.match(out.systemMessage, /^🧾 2 files changed · tests ✅ 3/)
    assert.match(out.systemMessage, /👀 Review: read 1 line in 1 file · skim 1 \(tests\)/)
  })

  it('blocks a failed or stale run and a result hidden by a pipe', () => {
    const { dir, agent } = started()
    write(dir, { 'src/a.js': 'x\n' })
    agent.fail('npm test', 'Exit code 1\n Tests  1 failed | 2 passed (3)')
    assert.match(parse(agent.stop().out).reason, /Tests failed \(1 failed\): `npm test`/)

    const b = started()
    write(b.dir, { 'src/a.js': 'x\n' })
    b.agent.ok('npm test', ' Tests  3 passed (3)')
    write(b.dir, { 'src/a.js': 'y\n' })
    assert.match(parse(b.agent.stop().out).reason, /Tests ran before your last code change/)

    const c = started()
    write(c.dir, { 'src/a.js': 'x\n' })
    c.agent.ok('npm test | tail -5')
    assert.match(parse(c.agent.stop().out).reason, /Tests result is unknown \(exit code hidden by a later command\)/)
  })

  it('never sends the agent back more than maxBlocks times', () => {
    const { dir, agent } = started()
    write(dir, { 'src/a.js': '1\n' })
    assert.equal(parse(agent.stop().out).decision, 'block') // tests not run
    write(dir, { 'src/a.js': '// TODO finish\n' })
    assert.equal(parse(agent.stop('', { stop_hook_active: true }).out).decision, 'block') // new: TODO
    write(dir, { 'src/a.js': 'debugger\n' })
    const third = parse(agent.stop('', { stop_hook_active: true }).out)
    assert.equal(third.decision, undefined, 'third time it must let the agent stop')
    assert.match(third.systemMessage, /Debugger statement/)
  })

  it('a docs-only edit after the tests does not make them stale', () => {
    const { dir, agent } = started({ 'README.md': 'hi\n' })
    write(dir, { 'src/a.js': '2\n' })
    agent.ok('npm test', ' Tests  3 passed (3)')
    write(dir, { 'README.md': 'hi, updated\n' })
    assert.equal(parse(agent.stop().out).decision, undefined)
  })

  it('does not ask for tests when only config or docs changed', () => {
    const { dir, agent } = started({ 'README.md': 'hi\n' })
    write(dir, { 'README.md': 'new\n', 'package.json': PKG.replace('"app"', '"app2"') })
    const out = parse(agent.stop().out)
    assert.equal(out.decision, undefined)
  })

  it('is quiet when nothing changed, and when asked again about the same code', () => {
    const { dir, agent } = started()
    assert.equal(agent.stop().out, '')
    write(dir, { 'src/a.js': '2\n' })
    agent.ok('npm test', ' Tests  3 passed (3)')
    assert.ok(agent.stop().out)
    assert.equal(agent.stop('Here is the answer to your question.').out, '')
  })

  it('respects mode off and warn', () => {
    const off = started({ 'receipts.json': '{"mode":"off"}' })
    write(off.dir, { 'src/a.js': '2\n' })
    assert.equal(off.agent.stop().out, '')

    const warn = started({ 'receipts.json': '{"mode":"warn"}' })
    write(warn.dir, { 'src/a.js': '2\n' })
    const out = parse(warn.agent.stop().out)
    assert.equal(out.decision, undefined)
    assert.match(out.systemMessage, /tests ⚠️ not run/)
  })

  it('ignores findings listed in the config', () => {
    const { dir, agent } = started({ 'receipts.json': '{"ignore":["verify","unfinished:todo"]}' })
    write(dir, { 'src/a.js': '// TODO later\n' })
    assert.equal(parse(agent.stop().out).decision, undefined)
  })

  it('uses custom commands from the config', () => {
    const dir = makeRepo({ 'Makefile': 'build:\n\techo\n', 'receipts.json': '{"commands":{"test":"make verify"}}', 'main.go': 'package main\n' })
    const agent = claude(dir)
    agent.start()
    write(dir, { 'main.go': 'package main\n// x\n' })
    assert.match(parse(agent.stop().out).reason, /Tests never ran on these changes\. Run `make verify`/)
  })
})

describe('claims', () => {
  const claimCase = (message, setup) => {
    const { dir, agent } = started({ 'test/a.test.js': 'expect(1).toBe(1)\n' })
    write(dir, { 'src/a.js': '2\n' })
    setup?.(dir, agent)
    agent.ok('npm test', ' Tests  70 passed (70)') // tests are fine, so only the claim matters
    return parse(agent.stop(message).out)
  }

  it('catches claims that the recording contradicts', () => {
    const r = claimCase('Done! I added tests for this and updated the README.')
    assert.equal(r.decision, 'block')
    assert.match(r.reason, /You said you added tests, but no test file has new lines/)
    assert.match(r.reason, /You said you updated the docs, but no doc file changed/)
  })

  it('catches "tests pass" when they did not run after the change', () => {
    const { dir, agent } = started()
    write(dir, { 'src/a.js': '2\n' })
    agent.ok('npm test', ' Tests  3 passed (3)')
    write(dir, { 'src/a.js': '3\n' })
    const r = parse(agent.stop('Fixed it. All tests pass.').out)
    assert.match(r.reason, /You said the tests pass, but it last ran before your final code changes/)
  })

  it('does not treat negations, instructions or questions as claims', () => {
    for (const msg of [
      "I didn't run the tests yet.",
      'Make sure the build succeeds before merging.',
      'Once the typecheck passes, you can merge.',
      'Should I check that lint is clean?',
      'I have not added tests for this.',
    ]) {
      const r = claimCase(msg)
      assert.equal(r.decision, undefined, msg)
    }
  })

  it('warns when the number of passing tests is wrong', () => {
    const r = claimCase('All 72 tests pass.')
    assert.equal(r.decision, undefined)
    assert.match(r.systemMessage, /you said 72 tests pass, but the last recorded run had 70/i)
  })

  it('checks "no new dependencies"', () => {
    const r = claimCase('Done, no new dependencies.', (dir) => write(dir, { 'package.json': JSON.stringify({ name: 'app', scripts: { test: 'vitest run' }, dependencies: { 'left-pad': '1' } }) }))
    assert.match(r.reason, /You said no new dependencies, but `left-pad`/)
  })

  it('accepts true claims', () => {
    const r = claimCase('All tests pass and I added tests.', (dir) => write(dir, { 'test/a.test.js': 'expect(1).toBe(1)\nexpect(2).toBe(2)\n' }))
    assert.equal(r.decision, undefined)
  })
})

describe('unfinished work and test tricks', () => {
  it('flags new TODOs and stubs, but not moved ones', () => {
    const { dir, agent } = started({ 'src/old.js': '// TODO: old one\nexport const x = 1\n' })
    write(dir, {
      'src/a.js': 'export function pay() {\n  // TODO handle refunds\n  throw new Error("not implemented")\n}\n',
      'src/old.js': 'export const x = 1\n',
      'src/new.js': '// TODO: old one\n',
    })
    agent.ok('ls')
    const f = facts(dir)
    assert.match(f, /New TODO\/FIXME left in the code \(src\/a\.js:2\)/)
    assert.doesNotMatch(f, /TODO[^\n]*src\/new\.js/)
    assert.match(f, /Unfinished stub \("not implemented"\) \(src\/a\.js:3\)/)
  })

  it('flags debugger statements and debug prints in source, not in tests', () => {
    const { dir, agent } = started()
    write(dir, { 'src/a.js': 'debugger\nconsole.log("x")\n', 'test/a.test.js': 'console.log("ok")\n' })
    agent.ok('ls')
    const f = facts(dir)
    assert.match(f, /Problem \(Unfinished work\): Debugger statement left in \(src\/a\.js:1\)/)
    assert.match(f, /Note \(Unfinished work\): Debug output[^\n]*\(src\/a\.js:2\)/)
    assert.doesNotMatch(f, /Debug output[^\n]*test\/a\.test\.js/)
  })

  it('catches a changed expected value in a test', () => {
    const { dir, agent } = started({ 'test/sum.test.js': 'test("sum", () => {\n  expect(sum(1, 2)).toBe(3)\n  assert.equal(total(), 10)\n})\n' })
    write(dir, { 'test/sum.test.js': 'test("sum", () => {\n  expect(sum(1, 2)).toBe(4)\n  assert.equal(total(), 11)\n})\n' })
    agent.ok('ls')
    const f = facts(dir)
    assert.match(f, /Expected value in a test was changed \(test\/sum\.test\.js:2 \(3 → 4\), test\/sum\.test\.js:3 \(10 → 11\)\)/)
  })

  it('catches assertions removed from tests', () => {
    const { dir, agent } = started({ 'test/a.test.js': 'test("a", () => {\n  expect(a).toBe(1)\n  expect(b).toBe(2)\n  expect(c).toBe(3)\n})\n' })
    write(dir, { 'test/a.test.js': 'test("a", () => {\n})\n' })
    agent.ok('ls')
    assert.match(facts(dir), /Problem \(Test integrity\): 3 assertions removed from tests/)
  })
})

describe('security', () => {
  it('blocks secrets in code and env files, but not placeholders', () => {
    const { dir, agent } = started()
    write(dir, {
      'src/a.js': 'const key = "AKIAABCDEFGHIJKLMNOP"\nconst password = "hunter2hunter2"\nconst dbPassword = "changeme"\nconst token = process.env.TOKEN\n',
      '.env': 'TOKEN=abc\n',
      '.env.example': 'TOKEN=\n',
    })
    agent.ok('ls')
    const f = facts(dir)
    assert.match(f, /Secret or API key written into the code \(src\/a\.js:1\)/)
    assert.match(f, /Hardcoded password or key \(src\/a\.js:2\)/)
    assert.doesNotMatch(f, /src\/a\.js:3/)
    assert.match(f, /File with secrets is part of the change \(\.env\)/)
  })

  it('warns about unsafe settings', () => {
    const { dir, agent } = started()
    write(dir, {
      'src/a.js': 'https.request({ rejectUnauthorized: false })\ndb.query("SELECT * FROM users WHERE id = " + id)\nel.innerHTML = html\n',
    })
    agent.ok('ls')
    const f = facts(dir)
    assert.match(f, /TLS certificate checks turned off/)
    assert.match(f, /SQL built by joining strings/)
    assert.match(f, /Raw HTML inserted into the page/)
  })
})

describe('dependencies', () => {
  const run = async (deps, lookup, extra = {}) => {
    const dir = makeRepo({ 'package.json': JSON.stringify({ name: 'app', dependencies: { hono: '^4' } }), ...extra })
    claude(dir).start()
    write(dir, { 'package.json': JSON.stringify({ name: 'app', dependencies: { hono: '^4', ...deps } }) })
    return (await analyze(collectFacts(dir), { lookup })).findings
  }
  const day = 86_400_000

  it('blocks packages that do not exist', async () => {
    const findings = await run({ 'super-fast-json-parse': '^1' }, async () => ({ exists: false }))
    assert.ok(findings.some((f) => f.id === 'deps:missing:super-fast-json-parse' && f.level === 'block'))
  })

  it('blocks a barely used package one letter away from a popular one', async () => {
    const findings = await run({ lodahs: '^1' }, async () => ({ exists: true, created: new Date(Date.now() - 400 * day).toISOString(), downloads: 12 }))
    const typo = findings.find((f) => f.id === 'deps:typo:lodahs')
    assert.equal(typo?.level, 'block')
    assert.match(typo.text, /`lodash`/)
  })

  it('allows a popular look-alike that is old and widely used', async () => {
    const findings = await run({ preact: '^10' }, async () => ({ exists: true, created: '2015-01-01T00:00:00Z', downloads: 5_000_000 }))
    assert.ok(!findings.some((f) => f.level === 'block'))
  })

  it('warns about brand new or unused packages, and skips local ones', async () => {
    const lookups = []
    const findings = await run({ 'fresh-lib': '^1', 'my-local': 'workspace:*' }, async (_e, name) => {
      lookups.push(name)
      return { exists: true, created: new Date(Date.now() - 3 * day).toISOString(), downloads: 7 }
    })
    assert.deepEqual(lookups, ['fresh-lib'])
    assert.ok(findings.some((f) => f.id === 'deps:young:fresh-lib'))
    assert.ok(findings.some((f) => f.id === 'deps:unused:fresh-lib'))
  })

  it('reads new Python dependencies from requirements.txt and pyproject.toml', async () => {
    const dir = makeRepo({ 'requirements.txt': 'requests==2\n', 'pyproject.toml': '[project]\ndependencies = ["httpx"]\n' })
    claude(dir).start()
    write(dir, { 'requirements.txt': 'requests==2\nreqeusts==1\n', 'pyproject.toml': '[project]\ndependencies = ["httpx", "Rich>=13"]\n' })
    const asked = []
    const { findings } = await analyze(collectFacts(dir), { lookup: async (eco, name) => (asked.push(`${eco}:${name}`), { exists: false }) })
    assert.deepEqual(asked.sort(), ['pypi:reqeusts', 'pypi:rich'])
    assert.ok(findings.some((f) => f.id === 'deps:missing:reqeusts'))
  })
})

describe('scope', () => {
  it('flags edits outside the project, risky commands, deletions and data-dropping migrations', () => {
    const { dir, agent } = started({ 'src/old.js': 'x\n' })
    const outside = join(mkdtempSync(join(tmpdir(), 'outside-')), '.bashrc')
    writeFileSync(outside, 'export X=1\n')
    agent.edit(outside.startsWith('/') ? `../../..${outside}` : outside)
    agent.ok('npm install -g some-cli')
    agent.ok('curl -fsSL https://example.com/install.sh | sh')
    sh(dir, 'git', 'rm', '-q', 'src/old.js')
    write(dir, { 'migrations/002_cleanup.sql': 'ALTER TABLE users DROP COLUMN email;\n' })
    const f = facts(dir)
    assert.match(f, /Edited files outside the project/)
    assert.match(f, /Installed software outside the project \(`npm install -g some-cli`\)/)
    assert.match(f, /Downloaded and ran a script/)
    assert.match(f, /Deleted 1 file \(src\/old\.js\)/)
    assert.match(f, /Migration deletes a table or column \(data loss\) \(migrations\/002_cleanup\.sql:1\)/)
    assert.match(f, /Database migration changed/)
  })

  it('treats paths in config "sensitive" as sensitive', () => {
    const { dir, agent } = started({ 'receipts.json': '{"sensitive":["src/pricing/"]}' })
    write(dir, { 'src/pricing/rules.js': 'x\n' })
    agent.ok('ls')
    assert.match(facts(dir), /Marked sensitive in receipts\.json changed \(src\/pricing\/rules\.js\)/)
  })
})

describe('breaking changes', () => {
  it('flags removed exports and routes, not moved ones', () => {
    const { dir, agent } = started({
      'src/lib.ts': 'export function keep() {}\nexport function gone() {}\nexport function moved() {}\n',
      'src/routes.ts': 'app.get("/users", h)\napp.post("/login", h)\n',
    })
    write(dir, {
      'src/lib.ts': 'export function keep() {}\n',
      'src/other.ts': 'export function moved() {}\n',
      'src/routes.ts': 'app.get("/users", h)\n',
    })
    agent.ok('ls')
    const f = facts(dir)
    assert.match(f, /Public function or export removed[^\n]*`gone` \(src\/lib\.ts:2\)/)
    assert.doesNotMatch(f, /`moved`/)
    assert.match(f, /API route removed \(POST \/login \(src\/routes\.ts:2\)\)/)
  })

  it('blocks a new env var missing from .env.example', () => {
    const { dir, agent } = started({ '.env.example': 'DATABASE_URL=\n' })
    write(dir, { 'src/a.js': 'const a = process.env.DATABASE_URL\nconst b = process.env.STRIPE_KEY\nconst c = process.env.NODE_ENV\n' })
    agent.ok('ls')
    const f = facts(dir)
    assert.match(f, /Problem \(Breaking changes\): New environment variable not in \.env\.example \(`STRIPE_KEY` \(src\/a\.js:2\)\)/)
    assert.doesNotMatch(f, /DATABASE_URL|NODE_ENV/)
  })
})

describe('review map', () => {
  it('splits the change into read, skim and skip', () => {
    const { dir, agent } = started({ 'src/fmt.js': 'const a = 1\n', 'package-lock.json': '{}\n', 'test/a.test.js': 'x\n' })
    write(dir, {
      'src/a.js': 'export const a = 1\nexport const b = 2\n',
      'src/fmt.js': 'const a  =  1   \n',
      'package-lock.json': '{\n"lockfileVersion": 3\n}\n',
      'test/a.test.js': 'x\ny\n',
    })
    agent.ok('ls')
    assert.match(facts(dir), /Review: read 1 line in 1 file · skim 1 \(tests\) · skip \d+ \((?:lockfile, whitespace only|whitespace only, lockfile)\)/)
  })
})

describe('receipts check (CLI / CI)', () => {
  it('exits 1 on blocking problems and 0 when clean, and compares with --base', () => {
    const dir = makeRepo({ 'src/a.js': 'x\n' })
    sh(dir, 'git', 'checkout', '-q', '-b', 'feature')
    write(dir, { 'src/a.js': 'x\n// TODO later\n' })
    sh(dir, 'git', 'commit', '-qam', 'wip')
    const r = cli(dir, ['check', '--base', 'main'].map((a) => (a === 'main' ? sh(dir, 'git', 'rev-parse', 'HEAD~1').trim() : a)))
    assert.equal(r.code, 1)
    assert.match(r.out, /✗ Unfinished work: New TODO\/FIXME/)

    const json = JSON.parse(cli(dir, ['check', '--json', '--base', sh(dir, 'git', 'rev-parse', 'HEAD~1').trim()]).out)
    assert.equal(json.findings[0].id, 'unfinished:todo')

    const clean = makeRepo()
    assert.equal(cli(clean, ['check']).code, 0)
  })

  it('says clearly when the base ref does not exist', () => {
    const r = cli(makeRepo(), ['check', '--base', 'nope'])
    assert.equal(r.code, 1)
    assert.match(r.err, /can't find git ref "nope"/)
  })
})

describe('Codex and Cursor', () => {
  it('records Codex shell commands with exit codes and blocks on Stop', () => {
    const dir = makeRepo({ 'package.json': PKG, 'src/a.js': '1\n' })
    const base = { session_id: 'c1', turn_id: 't1', cwd: dir, model: 'gpt', transcript_path: null }
    const send = (p) => cli(dir, ['hook'], JSON.stringify({ ...base, ...p }))
    send({ hook_event_name: 'SessionStart', source: 'startup' })
    write(dir, { 'src/a.js': '2\n' })
    send({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { output: 'boom', exit_code: 1 } })
    const out = parse(send({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done.' }).out)
    assert.equal(out.decision, 'block')
    assert.match(out.reason, /Tests failed: `npm test`/)
    assert.equal(out.systemMessage, undefined)
  })

  it('records Cursor commands and continues with a follow-up message', () => {
    const dir = makeRepo({ 'package.json': PKG, 'src/a.js': '1\n' })
    const base = { conversation_id: 'k1', generation_id: 'g', workspace_roots: [dir], cursor_version: '2.0' }
    const send = (p) => cli(dir, ['hook'], JSON.stringify({ ...base, ...p }))
    write(dir, { 'src/a.js': '2\n' })
    send({ hook_event_name: 'afterFileEdit', file_path: join(dir, 'src/a.js'), edits: [] })
    send({ hook_event_name: 'afterShellExecution', command: 'npm test', output: ' Tests  4 passed (4)', duration: 10 })
    write(dir, { 'src/a.js': '// TODO\n' })
    const out = parse(send({ hook_event_name: 'stop', status: 'completed', loop_count: 0 }).out)
    assert.match(out.followup_message, /New TODO\/FIXME/)
    const later = parse(send({ hook_event_name: 'stop', status: 'completed', loop_count: 2 }).out)
    assert.equal(later.followup_message, undefined)
  })

  it('init writes and merges hook configs without duplicating', () => {
    const dir = makeRepo()
    writeFileSync(join(dir, 'AGENTS.md'), '# Project rules\n')
    assert.equal(cli(dir, ['init', 'codex']).code, 0)
    cli(dir, ['init', 'codex'])
    const codex = JSON.parse(readFileSync(join(dir, '.codex', 'hooks.json'), 'utf8'))
    assert.equal(codex.hooks.Stop.length, 1)
    assert.equal(codex.hooks.PostToolUse[0].matcher, 'Bash|apply_patch')
    assert.match(codex.hooks.Stop[0].hooks[0].command, /receipts\.mjs" hook$/)
    const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    assert.match(agents, /^# Project rules\n\n## Receipts/)
    assert.equal(agents.match(/## Receipts/g).length, 1)

    writeFileSync(join(dir, '.cursor-tmp'), '')
    cli(dir, ['init', 'cursor'])
    const cursor = JSON.parse(readFileSync(join(dir, '.cursor', 'hooks.json'), 'utf8'))
    assert.equal(cursor.version, 1)
    assert.deepEqual(Object.keys(cursor.hooks).sort(), ['afterFileEdit', 'afterShellExecution', 'stop'])
    assert.ok(existsSync(join(dir, '.cursor', 'rules', 'receipts.mdc')))
  })
})

describe('the receipt', () => {
  it('includes problems, warnings and the review guide', () => {
    const { dir, agent } = started()
    write(dir, { 'src/a.js': 'export const a = 2\nconsole.log(a)\n// TODO x\n' })
    agent.ok('npm test', ' Tests  3 passed (3)')
    cli(dir, ['write'], 'title: change a\nwhy: needed 2\n')
    const md = cli(dir, ['show']).out
    assert.match(md, /\*\*🚩 Problems\*\* [^\n]*\n- \*\*Unfinished work:\*\* New TODO\/FIXME left in the code \(src\/a\.js:3\)/)
    assert.match(md, /\*\*⚠️ Worth a look:\*\*\n- \*\*Unfinished work:\*\* Debug output/)
    assert.match(md, /\*\*👀 Review guide:\*\*\n- Read 3 lines in 1 file\n  - read `src\/a\.js` lines 1-3/)
  })
})
