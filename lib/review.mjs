// @ts-check
import { diffHunks } from './git.mjs'
import { isDoc, isNoise, isTest } from './paths.mjs'

/**
 * @typedef {import('./facts.mjs').Facts} Facts
 * @typedef {import('./findings.mjs').Finding} Finding
 * @typedef {{ file: string, lines: number, ranges: string[], reason?: string }} ReviewFile
 * @typedef {{ read: ReviewFile[], skim: ReviewFile[], skip: ReviewFile[], readLines: number, totalLines: number }} ReviewMap
 */

/**
 * Split the change into what a human should read, skim and skip.
 * No AI involved: formatting-only changes, lockfiles and generated files are
 * skipped, tests and docs are skimmed, everything else is read, riskiest first.
 * @param {Facts} f
 * @param {Finding[]} findings
 * @returns {ReviewMap}
 */
export function reviewMap(f, findings) {
  /** @type {ReviewMap} */
  const map = { read: [], skim: [], skip: [], readLines: 0, totalLines: 0 }
  if (!f.git || !f.baseTree || !f.tree) return map

  // line counts that ignore whitespace, so a reformat counts as nothing.
  // A changed line is one line to read, not one removed plus one added.
  const wsHunks = diffHunks(f.root, f.baseTree, f.tree, ['-w'])
  /** @type {Map<string, number>} */
  const meaningful = new Map()
  for (const h of wsHunks) meaningful.set(h.file, (meaningful.get(h.file) ?? 0) + Math.max(h.added.length, h.removed.length))
  const flagged = new Set(findings.flatMap((x) => (x.where ?? '').match(/[\w./@-]+\.\w+(?=:\d|\b)/g) ?? []))

  for (const file of f.files) {
    const total = Math.max(file.added, file.removed)
    map.totalLines += total
    const lines = meaningful.get(file.path) ?? 0
    if (isNoise(file.path)) {
      map.skip.push({ file: file.path, lines: total, ranges: [], reason: /lock|\.sum$/.test(file.path) ? 'lockfile' : 'generated' })
    } else if (file.status === 'R' && lines === 0) {
      map.skip.push({ file: file.path, lines: 0, ranges: [], reason: 'renamed' })
    } else if (lines === 0 && total > 0) {
      map.skip.push({ file: file.path, lines: total, ranges: [], reason: 'whitespace only' })
    } else if (isTest(file.path) || isDoc(file.path)) {
      map.skim.push({ file: file.path, lines, ranges: [], reason: isTest(file.path) ? 'tests' : 'docs' })
    } else {
      map.read.push({ file: file.path, lines, ranges: file.status === 'D' ? [] : ranges(wsHunks, file.path), reason: file.status === 'D' ? 'deleted' : undefined })
      map.readLines += lines
    }
  }
  // files with findings first, then the biggest changes
  map.read.sort((a, b) => Number(flagged.has(b.file)) - Number(flagged.has(a.file)) || b.lines - a.lines)
  return map
}

/**
 * @param {import('./git.mjs').Hunk[]} hunks
 * @param {string} file
 */
function ranges(hunks, file) {
  /** @type {[number, number][]} */
  const out = []
  for (const h of hunks) {
    if (h.file !== file) continue
    const start = h.count ? h.start : h.start
    const end = h.count ? h.start + h.count - 1 : h.start
    const prev = out.at(-1)
    if (prev && start - prev[1] <= 3) prev[1] = Math.max(prev[1], end)
    else out.push([start, end])
  }
  return out.slice(0, 4).map(([s, e]) => (s === e ? `${s}` : `${s}-${e}`))
}

/**
 * One line for people: "read 12 lines in 2 files, skim 30 (tests), skip 180 (lockfile, whitespace only)".
 * @param {ReviewMap} m
 */
export function reviewSummary(m) {
  if (!m.read.length && !m.skim.length && !m.skip.length) return ''
  const parts = []
  if (m.read.length) parts.push(`read ${m.readLines} line${m.readLines === 1 ? '' : 's'} in ${m.read.length} file${m.read.length === 1 ? '' : 's'}`)
  const skim = m.skim.reduce((n, x) => n + x.lines, 0)
  if (m.skim.length) parts.push(`skim ${skim} (${[...new Set(m.skim.map((x) => x.reason))].join(', ')})`)
  const skip = m.skip.reduce((n, x) => n + x.lines, 0)
  if (m.skip.length) parts.push(`skip ${skip} (${[...new Set(m.skip.map((x) => x.reason))].join(', ')})`)
  return parts.join(' · ')
}
