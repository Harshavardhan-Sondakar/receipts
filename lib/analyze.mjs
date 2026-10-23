// @ts-check
import { checkBreaking } from './checks/breaking.mjs'
import { checkClaims } from './checks/claims.mjs'
import { scanContent } from './checks/content.mjs'
import { checkDependencies, registryLookup } from './checks/deps.mjs'
import { checkScope } from './checks/scope.mjs'
import { verifyChecks } from './checks/verify.mjs'
import { applyIgnore } from './findings.mjs'
import { reviewMap } from './review.mjs'

/**
 * @typedef {import('./facts.mjs').Facts} Facts
 * @typedef {import('./findings.mjs').Finding} Finding
 * @typedef {import('./review.mjs').ReviewMap} ReviewMap
 * @typedef {import('./checks/deps.mjs').Lookup} Lookup
 */

/**
 * Run every check over the facts. Plain code only, the AI isn't asked anything.
 * @param {Facts} f
 * @param {{ message?: string, lookup?: Lookup | null }} [opts]
 * @returns {Promise<{ findings: Finding[], review: ReviewMap }>}
 */
export async function analyze(f, opts = {}) {
  const lookup =
    opts.lookup !== undefined ? opts.lookup : f.config.registry && !process.env.RECEIPTS_OFFLINE ? registryLookup(f.root) : null

  /** @type {Finding[]} */
  const findings = [
    ...verifyChecks(f),
    ...scanContent(f),
    ...(await checkDependencies(f, lookup)),
    ...checkScope(f),
    ...checkBreaking(f),
  ]
  // claims are checked last because some depend on the other findings
  findings.push(...checkClaims(opts.message, f, findings))

  const kept = applyIgnore(findings, f.config.ignore)
  // blocking problems first
  kept.sort((a, b) => Number(b.level === 'block') - Number(a.level === 'block'))
  return { findings: kept, review: reviewMap(f, kept) }
}
