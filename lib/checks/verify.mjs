// @ts-check
import { isCode, isTest } from '../paths.mjs'

/**
 * @typedef {import('../facts.mjs').Facts} Facts
 * @typedef {import('../facts.mjs').Check} Check
 * @typedef {import('../findings.mjs').Finding} Finding
 */

const KIND_NAMES = /** @type {Record<string, string>} */ ({ test: 'Tests', typecheck: 'Typecheck', lint: 'Lint', build: 'Build' })

/**
 * Did the checks this project has actually run on the final code, and pass?
 * Only asked when code changed; a docs-only change needs nothing.
 * @param {Facts} f
 * @returns {Finding[]}
 */
export function verifyChecks(f) {
  // only code and tests need checks; a config, docs or lockfile change doesn't
  if (!f.recorded || !f.files.some((x) => isCode(x.path) || isTest(x.path))) return []
  /** @type {Finding[]} */
  const out = []

  // kinds we care about: the ones this project has, plus any the agent ran
  const kinds = new Set(f.expected.map((e) => e.kind))
  for (const c of f.checks) for (const k of c.kinds) if (f.config.require.includes(k)) kinds.add(k)

  for (const kind of kinds) {
    const name = KIND_NAMES[kind] ?? kind
    const cmd = f.expected.find((e) => e.kind === kind)?.cmd
    // the most recent run that covered this kind
    /** @type {Check | undefined} */
    const last = f.checks.filter((c) => c.kinds.includes(kind)).sort((a, b) => b.at - a.at)[0]
    const run = last ? `\`${last.cmd}\`` : cmd ? `\`${cmd}\`` : `the ${kind} command`

    if (!last) {
      out.push({ id: `verify:${kind}:not-run`, cat: 'verify', level: 'block', text: `${name} never ran on these changes`, fix: `Run ${run}.` })
    } else if (last.ok === false) {
      const counts = last.counts?.failed ? ` (${last.counts.failed} failed)` : ''
      out.push({ id: `verify:${kind}:failed`, cat: 'verify', level: 'block', text: `${name} failed${counts}: ${run}`, fix: `Fix the failures and run ${run} again.` })
    } else if (last.stale) {
      out.push({
        id: `verify:${kind}:stale`,
        cat: 'verify',
        level: 'block',
        text: `${name} ran before your last code change: ${run}`,
        fix: `Run ${run} again on the final code.`,
      })
    } else if (last.ok === null) {
      out.push({
        id: `verify:${kind}:unknown`,
        cat: 'verify',
        level: 'block',
        text: `${name} result is unknown (${last.note ?? 'no exit code'}): ${run}`,
        fix: `Run ${run} again on its own (no \`| tail\`, \`|| true\` or \`; ...\` after it) so the result is recorded.`,
      })
    }
  }
  return out
}
