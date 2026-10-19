#!/usr/bin/env node
// @ts-check
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { collectFacts } from '../lib/facts.mjs'
import { record } from '../lib/record.mjs'
import { factsForAgent, parseNotes, renderReceipt } from '../lib/render.mjs'
import { append, currentTask, projectRoot, readLog, receiptsDir } from '../lib/store.mjs'

const HELP = `receipts: make AI coding agents show their work

Usage:
  receipts hook     record one hook event (reads the hook JSON on stdin)
  receipts facts    print what was recorded for the current task
  receipts write    write a receipt (reads the agent's notes on stdin)
  receipts show     print the latest receipt, e.g. for a PR description

Receipts are saved in .receipts/ in your project (it's ignored by git).
`

function readStdin() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

const [cmd] = process.argv.slice(2)

switch (cmd) {
  case 'hook': {
    // a hook must never break the agent: no output, always exit 0
    let input = null
    try {
      input = JSON.parse(readStdin())
    } catch {}
    record(input)
    process.exit(0)
  }

  case 'facts': {
    const root = projectRoot()
    console.log(factsForAgent(collectFacts(root)))
    break
  }

  case 'write': {
    if (process.stdin.isTTY) {
      console.error('receipts write reads notes from stdin, for example:\n  receipts write <<EOF\n  title: fix login\n  why: ...\n  EOF')
      process.exit(1)
    }
    const root = projectRoot()
    const facts = collectFacts(root)
    const notes = parseNotes(readStdin())
    const now = new Date()
    const md = renderReceipt(facts, notes, now)
    const dir = receiptsDir(root)
    const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
    const file = join(dir, `receipt-${stamp}.md`)
    writeFileSync(file, md)
    writeFileSync(join(dir, 'latest.md'), md)
    // the next task starts from here
    const { session } = currentTask(readLog(root))
    append(root, { t: 'receipt', at: now.getTime(), session: session ?? 'default', tree: facts.tree, file: relative(root, file) })
    // keep this short, the agent doesn't need to read the receipt back
    console.log(`Receipt saved to ${relative(root, file)} (copy at .receipts/latest.md)`)
    break
  }

  case 'show': {
    const file = join(projectRoot(), '.receipts', 'latest.md')
    if (!existsSync(file)) {
      console.error('No receipt yet. Ask your agent for one, or run "receipts write".')
      process.exit(1)
    }
    process.stdout.write(readFileSync(file, 'utf8'))
    break
  }

  case undefined:
  case '-h':
  case '--help':
  case 'help':
    process.stdout.write(HELP)
    break

  default:
    console.error(`Unknown command "${cmd}".\n`)
    process.stderr.write(HELP)
    process.exit(1)
}
