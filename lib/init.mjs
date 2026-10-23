// @ts-check
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * The command hooks should run. A path inside the npx cache can disappear,
 * so in that case use npx itself (or a global install if there is one).
 * @param {string} bin
 */
function hookCommand(bin) {
  if (!/[/\\]_npx[/\\]/.test(bin)) return `node "${bin}"`
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', ['receipts'], { stdio: 'ignore' })
    return 'receipts'
  } catch {
    const version = JSON.parse(readFileSync(join(dirname(bin), '..', 'package.json'), 'utf8')).version
    return `npx -y show-receipts@${version}`
  }
}

/**
 * @param {string} file
 * @returns {any}
 */
function readJson(file) {
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new Error(`${file} isn't valid JSON, fix or remove it first`)
  }
}

/**
 * @param {string} file
 * @param {unknown} data
 */
function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
}

/** @param {any} entry */
const isOurs = (entry) => JSON.stringify(entry).includes('receipts')

/**
 * Instructions for the agent, same idea as the Claude Code skill.
 * @param {string} cmd
 */
function instructions(cmd) {
  return `## Receipts

When you finish a coding task (or are asked for a receipt or PR description), write a receipt.
Hooks already recorded what changed and which commands ran, you only add what they can't know.

1. Run \`${cmd} facts\` from the project folder. Don't repeat these facts, they're added for you.
2. Run:

\`\`\`sh
${cmd} write <<'EOF'
title: <task in a few words>
why: <the problem>
assumed: <a guess that could be wrong>
rejected: <option skipped, and why>
not checked: <what you didn't verify>
look at: <file:line> <why>
EOF
\`\`\`

One short line per item, max 3 per key, skip keys with nothing real. Never claim a check passed if the facts don't show it.
`
}

/**
 * Set up Receipts for Codex or Cursor.
 * @param {'codex' | 'cursor'} agent
 * @param {{ global: boolean, root: string, bin: string }} opts
 * @returns {string[]} what was done, for the user
 */
export function init(agent, opts) {
  const cmd = hookCommand(opts.bin)
  const hook = `${cmd} hook`
  const base = opts.global ? homedir() : opts.root
  const done = []

  if (agent === 'codex') {
    const file = join(base, '.codex', 'hooks.json')
    const config = readJson(file)
    config.hooks ??= {}
    /** @type {[string, string | undefined][]} */
    const events = [
      ['SessionStart', undefined],
      ['PostToolUse', 'Bash|apply_patch'],
      ['Stop', undefined],
    ]
    for (const [event, matcher] of events) {
      const list = (config.hooks[event] ??= [])
      if (list.some(isOurs)) continue
      list.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: hook, timeout: 30 }] })
    }
    writeJson(file, config)
    done.push(`✓ hooks added to ${file}`)

    // Codex reads ~/.codex/AGENTS.md globally and AGENTS.md at the project root
    const agents = opts.global ? join(base, '.codex', 'AGENTS.md') : join(opts.root, 'AGENTS.md')
    const text = existsSync(agents) ? readFileSync(agents, 'utf8') : ''
    if (!text.includes('## Receipts')) {
      mkdirSync(dirname(agents), { recursive: true })
      writeFileSync(agents, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${text ? '\n' : ''}${instructions(cmd)}`)
      done.push(`✓ receipt instructions added to ${agents}`)
    }
    done.push('Next: start Codex and approve the new hooks when it asks ("Hooks need review").')
  } else {
    const file = join(base, '.cursor', 'hooks.json')
    const config = readJson(file)
    config.version ??= 1
    config.hooks ??= {}
    for (const event of ['afterShellExecution', 'afterFileEdit', 'stop']) {
      const list = (config.hooks[event] ??= [])
      if (!list.some(isOurs)) list.push({ command: hook })
    }
    writeJson(file, config)
    done.push(`✓ hooks added to ${file}`)
    if (!opts.global) {
      const rule = join(opts.root, '.cursor', 'rules', 'receipts.mdc')
      if (!existsSync(rule)) {
        mkdirSync(dirname(rule), { recursive: true })
        writeFileSync(rule, `---\ndescription: Write a receipt with recorded proof when finishing a coding task\nalwaysApply: false\n---\n\n${instructions(cmd)}`)
        done.push(`✓ receipt rule added to ${rule}`)
      }
    } else {
      done.push('For the receipt instructions, run "receipts init cursor" inside a project too.')
    }
    done.push("Next: restart Cursor. Note: Cursor doesn't report exit codes, so checks show as passed only when their output has a test summary.")
  }
  return done
}
