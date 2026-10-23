#!/usr/bin/env node
// @ts-check
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyze } from '../lib/analyze.mjs'
import { collectFacts } from '../lib/facts.mjs'
import { CATEGORY_LABELS } from '../lib/findings.mjs'
import { gate } from '../lib/gate.mjs'
import { init } from '../lib/init.mjs'
import { record } from '../lib/record.mjs'
import { checkStates, factsForAgent, parseNotes, renderReceipt } from '../lib/render.mjs'
import { reviewSummary } from '../lib/review.mjs'
import { append, currentTask, projectRoot, readLog, receiptsDir } from '../lib/store.mjs'

const HELP = `receipts: make AI coding agents prove their work

Usage:
  receipts check [--base <ref>] [--json]   check the current changes (exit 1 if something must be fixed)
  receipts facts                           what was recorded for the current task (used by the agent)
  receipts write                           write a receipt (reads the agent's notes on stdin)
  receipts show                            print the latest receipt, e.g. for a PR description
  receipts init codex|cursor [--global]    set up hooks for Codex or Cursor
  receipts hook                            used by the agent's hooks (reads JSON on stdin)

Settings go in receipts.json or "receipts" in package.json. Receipts are saved in .receipts/ (ignored by git).
`

function readStdin() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

const [cmd, ...args] = process.argv.slice(2)
const flag = (/** @type {string} */ name) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : (args[i + 1] ?? '')
}

// where receipts itself is installed
const HOME = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'))

/** @param {string} dir */
const insideHome = (dir) => {
  const real = realpathSync(dir)
  return real === HOME || real.startsWith(HOME + sep)
}

/**
 * The project the agent is working on. Run from inside the receipts folder
 * (e.g. after `cd` into the skill folder) we'd look at the wrong place, so stop
 * and say how to run it instead of quietly writing an empty receipt.
 */
function project() {
  const root = projectRoot()
  const fromEnv = process.env.RECEIPTS_DIR || process.env.CLAUDE_PROJECT_DIR
  if (insideHome(root) || (!fromEnv && insideHome(process.cwd()))) {
    console.error(
      `receipts: run this from your project folder, not from where receipts is installed.\n` +
        `For example: cd <your project> && node "${join(HOME, 'bin', 'receipts.mjs')}" ${cmd}`,
    )
    process.exit(2)
  }
  return root
}

const tty = process.stdout.isTTY && !process.env.NO_COLOR
const color = (/** @type {string} */ code, /** @type {string} */ s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s)

async function main() {
  switch (cmd) {
    case 'hook': {
      // a hook must never break the agent: no stray output, always exit 0
      let input = null
      try {
        input = JSON.parse(readStdin())
      } catch {}
      if (input && /^stop$/i.test(input.hook_event_name ?? '')) {
        try {
          const out = await gate(input)
          if (out) process.stdout.write(JSON.stringify(out))
        } catch (err) {
          if (process.env.RECEIPTS_DEBUG) console.error(err)
        }
      } else {
        record(input)
      }
      return 0
    }

    case 'facts': {
      const f = collectFacts(project())
      const { findings, review } = await analyze(f)
      console.log(factsForAgent(f, findings, review))
      return 0
    }

    case 'write': {
      if (process.stdin.isTTY) {
        console.error('receipts write reads notes from stdin, for example:\n  receipts write <<EOF\n  title: fix login\n  why: ...\n  EOF')
        return 1
      }
      const root = project()
      const f = collectFacts(root)
      const { findings, review } = await analyze(f)
      const notes = parseNotes(readStdin())
      const now = new Date()
      const md = renderReceipt(f, findings, review, notes, now)
      const dir = receiptsDir(root)
      const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
      const file = join(dir, `receipt-${stamp}.md`)
      writeFileSync(file, md)
      writeFileSync(join(dir, 'latest.md'), md)
      // the next task starts from here
      const { session } = currentTask(readLog(root))
      append(root, { t: 'receipt', at: now.getTime(), session: session ?? 'default', tree: f.tree, file: relative(root, file) })
      // keep this short, the agent doesn't need to read the receipt back
      console.log(`Receipt saved to ${relative(root, file)} (copy at .receipts/latest.md)`)
      return 0
    }

    case 'show': {
      const file = join(project(), '.receipts', 'latest.md')
      if (!existsSync(file)) {
        console.error('No receipt yet. Ask your agent for one, or run "receipts write".')
        return 1
      }
      process.stdout.write(readFileSync(file, 'utf8'))
      return 0
    }

    case 'check': {
      const root = project()
      const f = collectFacts(root, { base: flag('--base') })
      const { findings, review } = await analyze(f)
      const blocking = findings.filter((x) => x.level === 'block')
      if (args.includes('--json')) {
        const { hunks, runs, edits, config, ...rest } = f
        console.log(JSON.stringify({ ...rest, checks: checkStates(f), findings, review }, null, 2))
        return blocking.length ? 1 : 0
      }
      const lines = []
      lines.push(color('1', `receipts: ${f.files.length} file${f.files.length === 1 ? '' : 's'} changed`) + (flag('--base') ? ` since ${flag('--base')}` : ''))
      if (f.recorded && f.files.length) {
        const states = checkStates(f)
        if (states.length) {
          lines.push(
            `  ${states
              .map((s) => {
                const name = s.kind === 'test' ? 'tests' : s.kind
                if (s.state === 'pass') return color('32', `✓ ${name}`)
                const text = { fail: 'failed', stale: 'stale', unknown: 'unknown', 'not-run': 'not run' }[s.state]
                return color(s.state === 'fail' ? '31' : '33', `✗ ${name} ${text}`)
              })
              .join('   ')}`,
          )
        }
      }
      for (const x of findings) {
        const mark = x.level === 'block' ? color('31', '✗') : color('33', '!')
        lines.push(`  ${mark} ${color('2', `${CATEGORY_LABELS[x.cat]}:`)} ${x.text}${x.where ? color('2', ` (${x.where})`) : ''}`)
      }
      const r = reviewSummary(review)
      if (r) {
        lines.push(`  ${color('36', 'review:')} ${r}`)
        for (const file of review.read.slice(0, 5)) lines.push(color('2', `    ${file.file}${file.ranges.length ? `:${file.ranges.join(',')}` : ''}${file.reason ? ` (${file.reason})` : ''}`))
      }
      if (!findings.length && f.files.length) lines.push(color('32', '  nothing to flag'))
      console.log(lines.join('\n'))
      return blocking.length ? 1 : 0
    }

    case 'init': {
      const target = args[0]
      if (target !== 'codex' && target !== 'cursor') {
        console.error('Usage: receipts init codex|cursor [--global]')
        return 1
      }
      const msgs = init(target, { global: args.includes('--global'), root: projectRoot(), bin: join(HOME, 'bin', 'receipts.mjs') })
      for (const m of msgs) console.log(m)
      return 0
    }

    case undefined:
    case '-h':
    case '--help':
    case 'help':
      process.stdout.write(HELP)
      return 0

    default:
      console.error(`Unknown command "${cmd}".\n`)
      process.stderr.write(HELP)
      return 1
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    // the hook must stay silent; everything else can say what went wrong
    if (cmd === 'hook') process.exit(0)
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  },
)
