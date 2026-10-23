// @ts-check

/**
 * One thing Receipts noticed.
 * - block: the agent should fix it (or explain it) before it says it's done
 * - warn: worth a human look, the agent isn't sent back for it
 * @typedef {'block' | 'warn'} Level
 * @typedef {'verify' | 'claims' | 'unfinished' | 'tests' | 'security' | 'deps' | 'scope' | 'breaking'} Category
 * @typedef {{
 *   id: string,
 *   cat: Category,
 *   level: Level,
 *   text: string,
 *   where?: string,
 *   fix?: string,
 * }} Finding
 */

export const CATEGORY_LABELS = /** @type {Record<Category, string>} */ ({
  verify: 'Checks',
  claims: 'Claims',
  unfinished: 'Unfinished work',
  tests: 'Test integrity',
  security: 'Security',
  deps: 'Dependencies',
  scope: 'Scope',
  breaking: 'Breaking changes',
})

/**
 * Group many hits of the same kind into one finding, so a file full of
 * console.logs is one line, not twenty.
 * @param {{ id: string, cat: Category, level: Level, text: string, fix?: string }} base
 * @param {string[]} where
 * @returns {Finding}
 */
export function grouped(base, where) {
  const shown = where.slice(0, 3).join(', ')
  const more = where.length > 3 ? ` (+${where.length - 3} more)` : ''
  return { ...base, where: shown + more }
}

/**
 * Remove ignored findings: by id, by id prefix ("debug-print") or by category ("deps").
 * @param {Finding[]} findings
 * @param {string[]} ignore
 */
export function applyIgnore(findings, ignore) {
  if (!ignore.length) return findings
  return findings.filter((f) => !ignore.some((i) => f.id === i || f.id.startsWith(`${i}:`) || f.cat === i))
}
