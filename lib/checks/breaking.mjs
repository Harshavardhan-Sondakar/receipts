// @ts-check
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { grouped } from '../findings.mjs'
import { isNoise, isTest } from '../paths.mjs'

/**
 * @typedef {import('../facts.mjs').Facts} Facts
 * @typedef {import('../findings.mjs').Finding} Finding
 */

// public names declared on one line, per language
/** @type {[RegExp, RegExp][]} file pattern, declaration pattern (name in group 1) */
const EXPORTS = [
  [
    /\.[cm]?[jt]sx?$/,
    /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|abstract\s+class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  ],
  [/\.py$/, /^(?:async\s+)?(?:def|class)\s+([A-Za-z]\w*)/],
  [/\.go$/, /^func\s+(?:\([^)]*\)\s+)?([A-Z]\w*)\s*[([]/],
  [/\.rs$/, /^\s*pub\s+(?:async\s+)?(?:fn|struct|enum|trait|type|const)\s+([A-Za-z_]\w*)/],
  [/\.(java|kt|cs)$/, /^\s*public\s+(?:static\s+)?(?:final\s+)?(?:abstract\s+)?(?:class|interface|enum|record|[\w<>[\],\s]+?)\s+([A-Za-z_]\w*)\s*[({<]/],
]

const ROUTE =
  /\.(get|post|put|patch|delete|all)\s*\(\s*["'`](\/[^"'`]*)["'`]|@(?:app|router|bp|api)\.(get|post|put|patch|delete|route)\(\s*["'](\/[^"']*)["']|@(Get|Post|Put|Patch|Delete)(?:Mapping)?\(\s*["'](\/?[^"']*)["']/

const ENV_USE =
  /process\.env\.([A-Z_][A-Z0-9_]*)|process\.env\[\s*["']([A-Z_][A-Z0-9_]*)["']\s*\]|import\.meta\.env\.([A-Z_][A-Z0-9_]*)|os\.environ\[\s*["']([A-Z_][A-Z0-9_]*)["']\s*\]|os\.(?:environ\.get|getenv)\(\s*["']([A-Z_][A-Z0-9_]*)["']|Deno\.env\.get\(\s*["']([A-Z_][A-Z0-9_]*)["']|env::var\(\s*"([A-Z_][A-Z0-9_]*)"|os\.Getenv\(\s*"([A-Z_][A-Z0-9_]*)"/g

// set by the system or tooling, nobody puts these in .env.example
const COMMON_ENV = new Set(['NODE_ENV', 'CI', 'HOME', 'PATH', 'PWD', 'TZ', 'DEBUG', 'LANG', 'USER', 'SHELL', 'TERM', 'TMPDIR', 'VERCEL', 'VERCEL_ENV', 'MODE', 'DEV', 'PROD', 'SSR', 'BASE_URL', 'GITHUB_ACTIONS'])

/**
 * Things other code or other people may depend on.
 * @param {Facts} f
 * @returns {Finding[]}
 */
export function checkBreaking(f) {
  /** @type {Finding[]} */
  const out = []
  const read = (/** @type {string} */ p) => {
    try {
      return readFileSync(join(f.root, p), 'utf8')
    } catch {
      return ''
    }
  }
  const addedText = f.hunks.flatMap((h) => h.added.map((a) => a.text)).join('\n')

  // removed exports / public functions that weren't just moved or renamed in place
  /** @type {string[]} */
  const removed = []
  for (const h of f.hunks) {
    if (isTest(h.oldFile) || isNoise(h.oldFile)) continue
    const lang = EXPORTS.find(([fileRe]) => fileRe.test(h.oldFile))
    if (!lang) continue
    const declRe = lang[1]
    const now = read(h.file)
    for (const r of h.removed) {
      const name = declRe.exec(r.text)?.[1]
      if (!name || name.startsWith('_')) continue
      const stillThere = new RegExp(`\\b${name}\\b`)
      // still declared in the file, or declared again somewhere in this change
      const lines = now.split('\n').filter((l) => declRe.test(l) && stillThere.test(l))
      const movedHere = addedText.split('\n').some((l) => stillThere.test(l) && EXPORTS.some(([, d]) => d.test(l)))
      if (!lines.length && !movedHere) removed.push(`\`${name}\` (${h.oldFile}:${r.line})`)
    }
  }
  if (removed.length) {
    out.push(grouped({ id: 'breaking:removed-export', cat: 'breaking', level: 'warn', text: 'Public function or export removed (other code may use it)' }, [...new Set(removed)]))
  }

  // API routes that disappeared
  /** @type {string[]} */
  const routes = []
  for (const h of f.hunks) {
    if (isTest(h.oldFile)) continue
    for (const r of h.removed) {
      const m = ROUTE.exec(r.text)
      if (!m) continue
      const method = (m[1] ?? m[3] ?? m[5] ?? '').toUpperCase()
      const path = m[2] ?? m[4] ?? m[6] ?? ''
      const still = new RegExp(`["'\`]${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'\`]`)
      if (!still.test(read(h.file)) && !still.test(addedText)) routes.push(`${method} ${path} (${h.oldFile}:${r.line})`)
    }
  }
  if (routes.length) out.push(grouped({ id: 'breaking:removed-route', cat: 'breaking', level: 'warn', text: 'API route removed' }, [...new Set(routes)]))

  // new environment variables the example file doesn't mention
  const exampleFile = ['.env.example', '.env.sample', '.env.template', '.env.dist', 'example.env'].find((p) => existsSync(join(f.root, p)))
  if (exampleFile) {
    const example = read(exampleFile)
    /** @type {string[]} */
    const missing = []
    for (const h of f.hunks) {
      if (isTest(h.file)) continue
      for (const a of h.added) {
        for (const m of a.text.matchAll(ENV_USE)) {
          const name = m.slice(1).find(Boolean)
          if (!name || COMMON_ENV.has(name) || new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`, 'm').test(example)) continue
          missing.push(`\`${name}\` (${h.file}:${a.line})`)
        }
      }
    }
    if (missing.length) {
      out.push(
        grouped(
          {
            id: 'breaking:env-missing',
            cat: 'breaking',
            level: 'block',
            text: `New environment variable not in ${exampleFile}`,
            fix: `Add it to ${exampleFile} with a placeholder value, so others know to set it.`,
          },
          [...new Set(missing)],
        ),
      )
    }
  }
  return out
}
