// @ts-check
import { CATEGORY_LABELS } from './findings.mjs'
import { reviewSummary } from './review.mjs'

/**
 * @typedef {import('./facts.mjs').Facts} Facts
 * @typedef {import('./facts.mjs').Check} Check
 * @typedef {import('./findings.mjs').Finding} Finding
 * @typedef {import('./review.mjs').ReviewMap} ReviewMap
 * @typedef {{ title?: string, why: string[], assumed: string[], rejected: string[], unverified: string[], lookAt: string[], ran: string[], notes: string[] }} Notes
 * @typedef {{ kind: string, state: 'pass' | 'fail' | 'stale' | 'unknown' | 'not-run', check?: Check, cmd?: string }} CheckState
 */

const MAX_FILES = 12
const MAX_ITEM = 240
const MAX_PER_KEY = 4

const ICON = { pass: '✅', fail: '❌', stale: '⚠️', unknown: '⚠️', 'not-run': '⚠️' }
const STATE_TEXT = { pass: '', fail: 'failed', stale: 'ran before last change', unknown: 'result unknown', 'not-run': 'not run' }

/**
 * Where each kind of check stands: tests, typecheck, lint, plus any other kind that ran.
 * @param {Facts} f
 * @returns {CheckState[]}
 */
export function checkStates(f) {
  const kinds = [...new Set([...f.expected.map((e) => e.kind), ...f.checks.flatMap((c) => c.kinds)])]
  const order = ['test', 'typecheck', 'lint', 'build']
  kinds.sort((a, b) => (order.indexOf(a) + 1 || 9) - (order.indexOf(b) + 1 || 9))
  return kinds.map((kind) => {
    const check = f.checks.filter((c) => c.kinds.includes(kind)).sort((a, b) => b.at - a.at)[0]
    const cmd = check?.cmd ?? f.expected.find((e) => e.kind === kind)?.cmd
    if (!check) return { kind, state: 'not-run', cmd }
    if (check.ok === false) return { kind, state: 'fail', check, cmd }
    if (check.stale) return { kind, state: 'stale', check, cmd }
    if (check.ok === null) return { kind, state: 'unknown', check, cmd }
    return { kind, state: 'pass', check, cmd }
  })
}

/** @param {CheckState} s */
function stateLine(s) {
  const name = s.kind === 'test' ? 'tests' : s.kind
  if (s.state === 'pass') return `${name} ${ICON.pass}${s.check?.counts?.passed ? ` ${s.check.counts.passed}` : ''}`
  return `${name} ${ICON[s.state]} ${STATE_TEXT[s.state]}`
}

/** @param {Finding} x */
function findingLine(x) {
  return `${x.text}${x.where ? ` (${x.where})` : ''}`
}

/**
 * Short summary shown to the person after a task. Never sent to the AI, so it costs no tokens.
 * @param {Facts} f
 * @param {Finding[]} findings
 * @param {ReviewMap} review
 */
export function userSummary(f, findings, review) {
  const lines = []
  const head = [`🧾 ${f.files.length} file${f.files.length === 1 ? '' : 's'} changed`]
  if (f.recorded && f.codeChanged) head.push(...checkStates(f).map(stateLine))
  lines.push(head.join(' · '))
  const important = findings
  for (const x of important.slice(0, 5)) lines.push(`   ${x.level === 'block' ? '🚩' : '⚠️'} ${CATEGORY_LABELS[x.cat]}: ${findingLine(x)}`)
  if (important.length > 5) lines.push(`   … and ${important.length - 5} more ("make a receipt" for all of them)`)
  const r = reviewSummary(review)
  if (r) {
    const first = review.read[0]
    const where = first?.ranges.length ? ` · start at ${first.file}:${first.ranges[0]}` : ''
    lines.push(`   👀 Review: ${r}${where}`)
  }
  return lines.join('\n')
}

/**
 * What the agent is told when it's sent back. Kept short, it costs tokens.
 * @param {Finding[]} blocking
 */
export function blockReason(blocking) {
  const items = blocking.slice(0, 6).map((x) => {
    const line = `- ${findingLine(x)}.${x.fix ? ` ${x.fix}` : ''}`
    return line.length > 260 ? `${line.slice(0, 259)}…` : line
  })
  const more = blocking.length > 6 ? `\n- …and ${blocking.length - 6} more of the same kind.` : ''
  return `Receipts: not done yet. Fix these, or tell the user why they're fine:\n${items.join('\n')}${more}\nThen make sure what you tell the user matches what happened.`
}

/**
 * The compact version for the receipt skill. Every line here costs tokens.
 * @param {Facts} f
 * @param {Finding[]} findings
 * @param {ReviewMap} review
 */
export function factsForAgent(f, findings, review) {
  const lines = []
  if (!f.recorded) {
    lines.push(
      'Nothing was recorded for this task (the hooks are not installed or did not run).',
      'Your receipt will be marked as self-reported. Add a "ran:" line for each check you ran, with its real result.',
    )
    if (f.files.length) lines.push('Changes below are compared with the last commit.')
  } else if (f.late) {
    lines.push('Note: recording started mid-task, changes are compared with the last commit.')
  }
  if (!f.files.length) lines.push('Changed: nothing')
  else {
    const shown = f.files.slice(0, MAX_FILES).map((x) => (f.git ? `${x.path} +${x.added}/-${x.removed}` : x.path))
    const more = f.files.length > MAX_FILES ? `, +${f.files.length - MAX_FILES} more` : ''
    lines.push(`Changed ${f.files.length} file${f.files.length === 1 ? '' : 's'}${totals(f)}: ${shown.join(', ')}${more}`)
  }
  if (f.recorded) {
    const checks = f.checks.map((c) => `${c.cmd}: ${resultText(c)}${c.stale ? ', but code changed after it ran' : ''}`)
    for (const cmd of f.notRun) checks.push(`${cmd}: not run`)
    lines.push(`Checks: ${checks.length ? checks.join(' | ') : 'none ran'}`)
  }
  for (const x of findings.slice(0, 10)) {
    lines.push(`${x.level === 'block' ? 'Problem' : 'Note'} (${CATEGORY_LABELS[x.cat]}): ${findingLine(x)}`)
  }
  const r = reviewSummary(review)
  if (r) lines.push(`Review: ${r}`)
  if (f.areas.length) lines.push(`Biggest changes: ${f.areas.join(', ')}`)
  return lines.join('\n')
}

/** @param {Check} c */
function resultText(c) {
  if (c.ok === true) return `passed${countText(c)}`
  if (c.ok === false) return `failed${c.code ? ` (exit ${c.code})` : ''}${countText(c)}`
  return c.note ?? 'result unknown'
}

/** @param {Check} c */
function countText(c) {
  if (!c.counts?.passed && !c.counts?.failed) return ''
  const parts = []
  if (c.counts.passed) parts.push(`${c.counts.passed} passed`)
  if (c.counts.failed) parts.push(`${c.counts.failed} failed`)
  return ` (${parts.join(', ')})`
}

/** @param {Facts} f */
function totals(f) {
  const added = f.files.reduce((n, x) => n + x.added, 0)
  const removed = f.files.reduce((n, x) => n + x.removed, 0)
  return f.git ? ` (+${added} −${removed})` : ''
}

/**
 * Parse what the agent wrote: simple "key: value" lines.
 * @param {string} text
 * @returns {Notes}
 */
export function parseNotes(text) {
  /** @type {Notes} */
  const notes = { why: [], assumed: [], rejected: [], unverified: [], lookAt: [], ran: [], notes: [] }
  /** @type {Record<string, keyof Notes>} */
  const keys = {
    title: 'title',
    task: 'title',
    why: 'why',
    reason: 'why',
    assumed: 'assumed',
    assumption: 'assumed',
    assumptions: 'assumed',
    rejected: 'rejected',
    alternatives: 'rejected',
    'not checked': 'unverified',
    'not verified': 'unverified',
    unverified: 'unverified',
    'look at': 'lookAt',
    'look closely at': 'lookAt',
    review: 'lookAt',
    ran: 'ran',
    note: 'notes',
    notes: 'notes',
    explained: 'notes',
  }
  /** @type {string[] | null} */
  let last = null
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^[-*]\s+/, '')
    if (!line) continue
    const m = /^([a-z][a-z ]{1,20}):\s*(.*)$/i.exec(line)
    const key = m ? keys[m[1].trim().toLowerCase()] : undefined
    if (m && key === 'title') {
      notes.title = clip(m[2])
      last = null
    } else if (m && key) {
      const list = /** @type {string[]} */ (notes[key])
      if (m[2] && list.length < MAX_PER_KEY) list.push(clip(m[2]))
      last = list
    } else if (last && last.length) {
      // a wrapped line belongs to the item before it
      last[last.length - 1] = clip(`${last[last.length - 1]} ${line}`)
    } else if (notes.notes.length < MAX_PER_KEY) {
      notes.notes.push(clip(line))
    }
  }
  return notes
}

/** @param {string} s */
function clip(s) {
  const t = s.trim()
  return t.length > MAX_ITEM ? `${t.slice(0, MAX_ITEM - 1)}…` : t
}

/**
 * The receipt people read, in Markdown.
 * @param {Facts} f
 * @param {Finding[]} findings
 * @param {ReviewMap} review
 * @param {Notes} n
 * @param {Date} [date]
 */
export function renderReceipt(f, findings, review, n, date = new Date()) {
  const out = []
  out.push(`## Receipt${n.title ? `: ${n.title}` : ''}`, '')

  if (!f.recorded) {
    out.push(
      `> ⚠️ **Self-reported.** Nothing was recorded for this task, so the checks below are the agent’s word, not evidence.${f.files.length ? ' Changed files are compared with the last commit.' : ''}`,
      '',
    )
  } else if (f.late) {
    out.push('> Recording started mid-task, so changes are compared with the last commit.', '')
  }

  // what changed
  if (f.files.length) {
    const shown = f.files.slice(0, MAX_FILES).map((x) => {
      const label = x.status === 'A' ? ' (new)' : x.status === 'D' ? ' (deleted)' : x.status === 'R' ? ` (renamed from ${x.oldPath})` : ''
      return `\`${x.path}\`${label}`
    })
    const more = f.files.length > MAX_FILES ? `, and ${f.files.length - MAX_FILES} more` : ''
    out.push(`**Changed:** ${f.files.length} file${f.files.length === 1 ? '' : 's'}${totals(f)}: ${shown.join(', ')}${more}`, '')
  } else if (f.recorded) {
    out.push('**Changed:** no files', '')
  }

  // checks
  if (f.recorded) {
    out.push('**Verified** (recorded, not claimed):')
    const states = checkStates(f)
    if (!states.length) out.push('- ⚠️ no tests or checks were run')
    for (const s of states) {
      if (s.check) {
        const icon = s.state === 'pass' ? '✅' : s.state === 'fail' ? '❌' : '⚠️'
        const stale = s.state === 'stale' ? ', **but the code changed after it ran**' : ''
        out.push(`- ${icon} \`${s.check.cmd}\`: ${resultText(s.check)}${stale}`)
      } else {
        out.push(`- ⚠️ \`${s.cmd}\`: never run`)
      }
    }
    out.push('')
  }
  if (n.ran.length) {
    out.push(`**Checks${f.recorded ? ' (agent says, not recorded)' : ' (self-reported)'}:**`)
    for (const r of n.ran) out.push(`- ${r}`)
    out.push('')
  }

  // problems found by the checks, grouped
  const blocking = findings.filter((x) => x.level === 'block')
  const warnings = findings.filter((x) => x.level === 'warn')
  if (blocking.length) {
    out.push('**🚩 Problems** (the agent should have fixed or explained these):')
    for (const x of blocking) out.push(`- **${CATEGORY_LABELS[x.cat]}:** ${findingLine(x)}`)
    out.push('')
  }
  if (warnings.length) {
    out.push('**⚠️ Worth a look:**')
    for (const x of warnings) out.push(`- **${CATEGORY_LABELS[x.cat]}:** ${findingLine(x)}`)
    out.push('')
  }

  // the agent's part
  /** @type {[string, string[]][]} */
  const sections = [
    ['Why', n.why],
    ['Assumed', n.assumed],
    ['Rejected', n.rejected],
    ['Not checked', n.unverified],
    ['Notes', n.notes],
  ]
  for (const [label, items] of sections) {
    if (!items.length) continue
    if (items.length === 1) out.push(`**${label}:** ${items[0]}`)
    else {
      out.push(`**${label}:**`)
      for (const i of items) out.push(`- ${i}`)
    }
  }
  if (sections.some(([, items]) => items.length)) out.push('')

  // where to look
  const r = reviewSummary(review)
  if (r || n.lookAt.length) {
    out.push('**👀 Review guide:**')
    if (r) out.push(`- ${r.charAt(0).toUpperCase()}${r.slice(1)}`)
    for (const file of review.read.slice(0, 5)) out.push(`  - read \`${file.file}\`${file.ranges.length ? ` lines ${file.ranges.join(', ')}` : ''}${file.reason ? ` (${file.reason})` : ''}`)
    for (const l of n.lookAt) out.push(`- ${l}`)
    out.push('')
  }

  out.push(`<sub>Made with [receipts](https://github.com/Harshavardhan-Sondakar/receipts) · ${date.toISOString().slice(0, 16).replace('T', ' ')} UTC</sub>`)
  return `${out.join('\n')}\n`
}
