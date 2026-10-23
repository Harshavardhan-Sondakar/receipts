import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { CLI, claude, cli, makeRepo, sh, write } from './helpers.mjs'

const facts = (dir) => cli(dir, ['facts']).out

describe('hook', () => {
  it('prints nothing and exits 0, even on bad input', () => {
    const dir = makeRepo()
    for (const input of ['not json', '', '{}', 'null', '{"hook_event_name":"PostToolUse","tool_name":"Bash"}']) {
      const r = cli(dir, ['hook'], input)
      assert.equal(r.code, 0)
      assert.equal(r.out, '')
      assert.equal(r.err, '')
    }
  })

  it('keeps .receipts out of git and leaves the staging area alone', () => {
    const dir = makeRepo()
    write(dir, { 'staged.txt': 'x' })
    sh(dir, 'git', 'add', 'staged.txt')
    const before = sh(dir, 'git', 'diff', '--cached', '--name-only')
    const agent = claude(dir)
    agent.start()
    write(dir, { 'new.txt': 'y' })
    agent.ok('npm test')
    assert.equal(sh(dir, 'git', 'diff', '--cached', '--name-only'), before)
    assert.doesNotMatch(sh(dir, 'git', 'status', '--porcelain'), /\.receipts/)
  })

  it('hides secrets in recorded commands', () => {
    const dir = makeRepo()
    const agent = claude(dir)
    agent.start()
    agent.ok('API_KEY=supersecret123 curl -H "Authorization: Bearer abcdefghijklmnop" https://me:pw123@example.com --token=t0k3nvalue')
    agent.ok('git push https://x:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/a/b')
    const log = readFileSync(join(dir, '.receipts', 'log.jsonl'), 'utf8')
    for (const secret of ['supersecret123', 'abcdefghijklmnop', 'pw123', 't0k3nvalue', 'ghp_']) assert.ok(!log.includes(secret), secret)
  })

  it('never stores command output', () => {
    const dir = makeRepo()
    const agent = claude(dir)
    agent.start()
    agent.ok('npm test', 'PRIVATE OUTPUT\n# pass 4\n# fail 0')
    const log = readFileSync(join(dir, '.receipts', 'log.jsonl'), 'utf8')
    assert.ok(!log.includes('PRIVATE'))
    assert.match(log, /"passed":4/)
  })
})

describe('facts', () => {
  it('only counts changes made after the session started', () => {
    const dir = makeRepo({ 'a.js': 'a\n' })
    write(dir, { 'mine.txt': 'the user was already working on this\n' })
    const agent = claude(dir)
    agent.start()
    write(dir, { 'a.js': 'a\nb\n' })
    agent.edit('a.js')
    const f = facts(dir)
    assert.match(f, /Changed 1 file \(\+1 −0\): a\.js \+1\/-0/)
    assert.doesNotMatch(f, /mine\.txt/)
  })

  it('records passing and failing checks with counts and exit codes', () => {
    const dir = makeRepo({ 'package.json': '{"scripts":{"test":"node --test","lint":"eslint ."}}' })
    const agent = claude(dir)
    agent.start()
    write(dir, { 'a.js': 'x\n' })
    agent.ok('npm test', '# pass 12\n# fail 0')
    agent.fail('npm run lint', 'Exit code 2\nlint errors')
    const f = facts(dir)
    assert.match(f, /npm test: passed \(12 passed\)/)
    assert.match(f, /npm run lint: failed \(exit 2\)/)
    assert.doesNotMatch(f, /but code changed/)
  })

  it('says when tests ran before the last change', () => {
    const dir = makeRepo()
    const agent = claude(dir)
    agent.start()
    write(dir, { 'a.js': '1\n' })
    agent.ok('npx vitest run')
    write(dir, { 'a.js': '2\n' })
    assert.match(facts(dir), /npx vitest run: passed, but code changed after it ran/)
  })

  it('catches changes made through shell commands too, not just edit tools', () => {
    const dir = makeRepo()
    const agent = claude(dir)
    agent.start()
    agent.ok('pytest')
    write(dir, { 'b.py': 'print(1)\n' }) // e.g. `sed -i` or a codegen script, no edit event
    agent.ok('ls')
    assert.match(facts(dir), /pytest: passed, but code changed after it ran/)
  })

  it('a later rerun of the same check replaces the stale one', () => {
    const dir = makeRepo()
    const agent = claude(dir)
    agent.start()
    write(dir, { 'a.js': '1\n' })
    agent.fail('npm test')
    write(dir, { 'a.js': '2\n' })
    agent.ok('npm test')
    const f = facts(dir)
    assert.match(f, /npm test: passed/)
    assert.doesNotMatch(f, /failed|changed after/)
  })

  it('lists project checks that never ran', () => {
    const dir = makeRepo({ 'package.json': '{"scripts":{"test":"vitest","typecheck":"tsc","lint":"biome check"}}', 'pnpm-lock.yaml': '' })
    const agent = claude(dir)
    agent.start()
    write(dir, { 'src/a.ts': 'export {}\n' })
    agent.ok('pnpm test')
    const f = facts(dir)
    assert.match(f, /pnpm run typecheck: not run/)
    assert.match(f, /pnpm run lint: not run/)
    assert.doesNotMatch(f, /pnpm run test: not run/)
  })

  it('does not count commands that only mention a test tool', () => {
    const dir = makeRepo()
    const agent = claude(dir)
    agent.start()
    write(dir, { 'a.js': '1\n' })
    agent.ok('cat vitest.config.ts')
    agent.ok('git commit -m "fix tests"')
    agent.ok('echo "run npm test later"')
    assert.match(facts(dir), /Checks: none ran/)
  })

  it('flags skipped tests, silenced checks, new deps and sensitive files', () => {
    const dir = makeRepo({ 'package.json': '{"dependencies":{"hono":"^4"}}', 'test/a.test.js': 'test("a", () => {})\n', 'src/x.ts': 'export {}\n' })
    const agent = claude(dir)
    agent.start()
    write(dir, {
      'package.json': '{"dependencies":{"hono":"^4","left-pad":"^1"}}',
      'test/a.test.js': 'test.only("a", () => {})\nit.skip("b", () => {})\n',
      'src/x.ts': '// @ts-ignore\nexport const a: number = "x"\n',
      'src/auth/login.ts': 'export {}\n',
      '.github/workflows/ci.yml': 'on: push\n',
    })
    agent.edit('src/x.ts')
    const f = facts(dir)
    assert.match(f, /Focused test \(\.only\)[^\n]*\(test\/a\.test\.js:1\)/)
    assert.match(f, /Test skipped \(test\/a\.test\.js:2\)/)
    assert.match(f, /Type error silenced[^\n]*\(src\/x\.ts:1\)/)
    assert.match(f, /1 new dependency \(`left-pad`\)/)
    assert.match(f, /Auth \/ security code changed \(src\/auth\/login\.ts\)/)
    assert.match(f, /CI config changed \(\.github\/workflows\/ci\.yml\)/)
  })

  it('flags deleted tests and code changed without tests', () => {
    const dir = makeRepo({ 'src/a.js': '1\n', 'test/a.test.js': 'x\n' })
    const agent = claude(dir)
    agent.start()
    sh(dir, 'git', 'rm', '-q', 'test/a.test.js')
    write(dir, { 'src/a.js': '2\n' })
    agent.ok('ls')
    assert.match(facts(dir), /Test file deleted \(test\/a\.test\.js\)/)

    const dir2 = makeRepo({ 'src/a.js': '1\n' })
    const agent2 = claude(dir2)
    agent2.start()
    write(dir2, { 'src/a.js': '2\n' })
    agent2.ok('ls')
    assert.match(facts(dir2), /Code changed but no tests were added or changed \(src\/a\.js\)/)
  })

  it('flags risky commands', () => {
    const dir = makeRepo()
    const agent = claude(dir)
    agent.start()
    agent.ok('git push --force origin main')
    agent.ok('git commit --no-verify -m wip')
    agent.ok('rm -rf node_modules') // fine
    const f = facts(dir)
    assert.match(f, /Ran a risky command: Force push/)
    assert.match(f, /--no-verify/)
    assert.doesNotMatch(f, /Recursive delete/)
  })

  it('points at the biggest changed regions with line numbers', () => {
    const dir = makeRepo({ 'big.js': 'a\n'.repeat(50) })
    const agent = claude(dir)
    agent.start()
    const lines = 'a\n'.repeat(50).split('\n')
    lines.splice(20, 0, ...Array(10).fill('new'))
    write(dir, { 'big.js': lines.join('\n') })
    agent.ok('ls')
    assert.match(facts(dir), /Biggest changes: big\.js:21-30/)
  })

  it('compares with the last commit when recording started mid-task', () => {
    const dir = makeRepo({ 'a.js': '1\n' })
    write(dir, { 'a.js': '2\n' }) // changed before the plugin saw anything
    claude(dir).ok('npm test')
    const f = facts(dir)
    assert.match(f, /recording started mid-task/)
    assert.match(f, /a\.js/)
  })

  it('stays short for the agent', () => {
    const files = {}
    for (let i = 0; i < 40; i++) files[`src/f${i}.js`] = `${i}\n`
    const dir = makeRepo(files)
    const agent = claude(dir)
    agent.start()
    for (let i = 0; i < 40; i++) files[`src/f${i}.js`] = `${i}\nchanged\n`
    write(dir, files)
    agent.ok('npm test')
    const f = facts(dir)
    assert.match(f, /\+28 more/)
    assert.ok(f.length < 1200, `facts are ${f.length} chars`)
  })

  it('works outside git by listing edited files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'receipts-nogit-'))
    try {
      const agent = claude(dir)
      agent.start()
      write(dir, { 'a.txt': 'x' })
      agent.edit('a.txt')
      agent.ok('npm test')
      const f = facts(dir)
      assert.match(f, /Changed 1 file: a\.txt/)
      assert.match(f, /npm test: passed/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports when nothing was recorded', () => {
    assert.match(facts(makeRepo()), /Nothing was recorded/)
  })
})

describe('write and show', () => {
  const notes = `title: rate limit login
why: unlimited password guessing
assumed: one server, so an in-memory counter is enough
rejected: Redis, extra dependency for one server
not checked: behaviour behind a proxy
look at: src/limit.js:1 window logic
`

  it('writes a receipt and starts a new task after it', () => {
    const dir = makeRepo()
    const agent = claude(dir)
    agent.start()
    write(dir, { 'src/limit.js': 'export const max = 5\n' })
    agent.edit('src/limit.js')
    agent.ok('npm test', '# pass 3\n# fail 0')

    const r = cli(dir, ['write'], notes)
    assert.equal(r.code, 0)
    assert.match(r.out, /^Receipt saved to \.receipts\/receipt-\d{8}-\d{6}\.md/)
    assert.ok(r.out.length < 120, 'confirmation should be one short line')

    const md = cli(dir, ['show']).out
    assert.match(md, /^## Receipt: rate limit login/)
    assert.match(md, /✅ `npm test`: passed \(3 passed\)/)
    assert.match(md, /\*\*Assumed:\*\* one server/)
    assert.match(md, /\*\*Not checked:\*\* behaviour behind a proxy/)
    assert.match(md, /- src\/limit\.js:1 window logic/)
    assert.match(md, /`src\/limit\.js` \(new\)/)

    // next task starts clean
    assert.match(facts(dir), /Changed: nothing/)
    write(dir, { 'src/limit.js': 'export const max = 10\n' })
    agent.edit('src/limit.js')
    assert.match(facts(dir), /Changed 1 file/)
    assert.doesNotMatch(facts(dir), /npm test/)
  })

  it('marks a receipt as self-reported when nothing was recorded', () => {
    const dir = makeRepo()
    cli(dir, ['write'], 'title: x\nran: npm test, 4 passed\n')
    const md = cli(dir, ['show']).out
    assert.match(md, /Self-reported/)
    assert.match(md, /\*\*Checks \(self-reported\):\*\*\n- npm test, 4 passed/)
  })

  it('keeps the agent part short', () => {
    const dir = makeRepo()
    const long = 'x'.repeat(1000)
    cli(dir, ['write'], `why: ${long}\nwhy: 2\nwhy: 3\nwhy: 4\nwhy: 5\nwhy: 6\n`)
    const md = cli(dir, ['show']).out
    assert.ok(!md.includes('x'.repeat(300)))
    assert.equal((md.match(/^- /gm) ?? []).length, 4)
  })

  it('show fails nicely when there is no receipt', () => {
    const r = cli(makeRepo(), ['show'])
    assert.equal(r.code, 1)
    assert.match(r.err, /No receipt yet/)
  })

  it('does not leave files outside .receipts', () => {
    const dir = makeRepo()
    claude(dir).start()
    cli(dir, ['write'], 'title: x\n')
    assert.equal(sh(dir, 'git', 'status', '--porcelain'), '')
    assert.ok(existsSync(join(dir, '.receipts', 'latest.md')))
  })
})

// bugs found in the first real run inside Claude Code
describe('real world', () => {
  it('refuses to run from the receipts folder itself, instead of writing an empty receipt', () => {
    const skillFolder = join(dirname(CLI), '..', 'skills', 'receipt')
    const r = cli(skillFolder, ['facts'])
    assert.equal(r.code, 2)
    assert.match(r.err, /run this from your project folder/)
    assert.equal(cli(skillFolder, ['write'], 'title: x\n').code, 2)
    assert.ok(!existsSync(join(skillFolder, '.receipts')))
  })

  it('counts test runs started with package manager options or in a subshell', () => {
    const dir = makeRepo()
    const agent = claude(dir)
    agent.start()
    write(dir, { 'src/a.ts': 'x\n' })
    agent.ok(`npm --prefix ${dir} test`)
    agent.ok(`(cd ${dir} && pnpm -C . run lint)`)
    const f = facts(dir)
    assert.match(f, /npm --prefix \S+ test: passed/)
    assert.match(f, /pnpm -C \. run lint\): passed/)
  })

  it('treats any command with a test summary in its output as a test run', () => {
    const dir = makeRepo()
    const agent = claude(dir)
    agent.start()
    write(dir, { 'src/a.ts': 'x\n' })
    agent.ok('S=/some/path; P=/other; ./scripts/check.sh', ' Test Files  5 passed (5)\n      Tests  71 passed (71)')
    assert.match(facts(dir), /check\.sh: passed \(71 passed\)/)
  })

  it('still lists changed files when nothing was recorded', () => {
    const dir = makeRepo({ 'src/a.ts': '1\n' })
    write(dir, { 'src/a.ts': '2\n', 'src/b.ts': 'new\n' })
    const f = facts(dir)
    assert.match(f, /Nothing was recorded/)
    assert.match(f, /compared with the last commit/)
    assert.match(f, /Changed 2 files/)
    cli(dir, ['write'], 'title: x\nran: npm test, 3 passed\n')
    const md = cli(dir, ['show']).out
    assert.match(md, /Self-reported\.\*\* .*compared with the last commit/)
    assert.match(md, /`src\/b\.ts` \(new\)/)
  })

  it('does not trust the exit code when a check is piped into another command', () => {
    const dir = makeRepo()
    const agent = claude(dir)
    agent.start()
    write(dir, { 'src/a.ts': 'x\n' })
    // tail succeeds even though tests failed
    agent.ok('npm test 2>&1 | tail -30', ' Tests  2 failed | 70 passed (72)')
    agent.ok('npx tsc --noEmit | head -20')
    agent.ok('set -o pipefail; npm run lint | tail')
    agent.ok('npm run build || true')
    agent.ok('cd app && npm run typecheck && echo ok')
    const f = facts(dir)
    assert.match(f, /npm run build \|\| true: exit code hidden/)
    assert.match(f, /npm run typecheck && echo ok: passed/)
    assert.match(f, /npm test 2>&1 \| tail -30: failed \(70 passed, 2 failed\)/)
    assert.match(f, /npx tsc --noEmit \| head -20: exit code hidden by a later command/)
    assert.match(f, /npm run lint \| tail: passed/)
  })
})
