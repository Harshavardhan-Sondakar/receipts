// @ts-check

/**
 * @typedef {import('./facts.mjs').Facts} Facts
 * @typedef {import('./facts.mjs').Check} Check
 * @typedef {{ title?: string, why: string[], assumed: string[], rejected: string[], unverified: string[], lookAt: string[], ran: string[], notes: string[] }} Notes
 */

const MAX_FILES = 12
const MAX_ITEM = 240
const MAX_PER_KEY = 4

/** @param {Check} c */
function checkStatus(c) {
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
 * The short version for the agent. Every line here costs tokens, so it's terse.
 * @param {Facts} f
 */
export function factsForAgent(f) {
  if (!f.recorded) {
    return [
      'Nothing was recorded for this task (the hooks are not installed or did not run).',
      'Your receipt will be marked as self-reported. Add a "ran:" line for each check you ran, with its real result.',
    ].join('\n')
  }
  const lines = []
  if (f.late) lines.push('Note: recording started mid-task, changes are compared with the last commit.')
  if (!f.files.length) lines.push('Changed: nothing')
  else {
    const shown = f.files.slice(0, MAX_FILES).map((x) => (f.git ? `${x.path} +${x.added}/-${x.removed}` : x.path))
    const more = f.files.length > MAX_FILES ? `, +${f.files.length - MAX_FILES} more` : ''
    lines.push(`Changed ${f.files.length} file${f.files.length === 1 ? '' : 's'}${totals(f)}: ${shown.join(', ')}${more}`)
  }
  const checks = f.checks.map((c) => `${c.cmd}: ${checkStatus(c)}${c.stale ? ', but code changed after it ran' : ''}`)
  for (const cmd of f.notRun) checks.push(`${cmd}: not run`)
  lines.push(`Checks: ${checks.length ? checks.join(' | ') : 'none ran'}`)
  if (f.flags.length) lines.push(`Flags: ${f.flags.join(' | ')}`)
  if (f.areas.length) lines.push(`Biggest changes: ${f.areas.join(', ')}`)
  return lines.join('\n')
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
 * @param {Notes} n
 * @param {Date} [date]
 */
export function renderReceipt(f, n, date = new Date()) {
  const out = []
  out.push(`## Receipt${n.title ? `: ${n.title}` : ''}`, '')

  if (!f.recorded) {
    out.push('> ⚠️ **Self-reported.** Nothing was recorded for this task, so the checks below are the agent’s word, not evidence.', '')
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
    if (!f.checks.length && !f.notRun.length) out.push('- ⚠️ no tests or checks were run')
    for (const c of f.checks) {
      const icon = c.ok === true && !c.stale ? '✅' : c.ok === false ? '❌' : '⚠️'
      const stale = c.stale ? ', **but the code changed after it ran**' : ''
      out.push(`- ${icon} \`${c.cmd}\`: ${checkStatus(c)}${stale}`)
    }
    for (const cmd of f.notRun) out.push(`- ⚠️ \`${cmd}\`: never run`)
    out.push('')
  }
  if (n.ran.length) {
    out.push(`**Checks${f.recorded ? ' (agent says, not recorded)' : ' (self-reported)'}:**`)
    for (const r of n.ran) out.push(`- ${r}`)
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

  const flags = f.flags
  if (flags.length || n.lookAt.length) {
    out.push('**Look closely at:**')
    for (const l of n.lookAt) out.push(`- ${l}`)
    for (const fl of flags) out.push(`- 🚩 ${fl}`)
    out.push('')
  }

  out.push(`<sub>Made with [receipts](https://github.com/Harshavardhan-Sondakar/receipts) · ${date.toISOString().slice(0, 16).replace('T', ' ')} UTC</sub>`)
  return `${out.join('\n')}\n`
}
