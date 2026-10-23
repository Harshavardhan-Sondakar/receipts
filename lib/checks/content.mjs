// @ts-check
import { grouped } from '../findings.mjs'
import { isCode, isDoc, isNoise, isTest } from '../paths.mjs'

/**
 * @typedef {import('../facts.mjs').Facts} Facts
 * @typedef {import('../findings.mjs').Finding} Finding
 * @typedef {import('../findings.mjs').Category} Category
 * @typedef {import('../findings.mjs').Level} Level
 * @typedef {{ id: string, cat: Category, level: Level, re: RegExp, text: string, fix?: string, tests?: 'only' | 'skip' }} Rule
 */

/** @type {Rule[]} */
const LINE_RULES = [
  // unfinished work
  {
    id: 'unfinished:todo',
    cat: 'unfinished',
    level: 'block',
    re: /(?:\/\/|#|\/\*|\*|<!--|--)\s*(?:TODO|FIXME|XXX|HACK)\b/,
    text: 'New TODO/FIXME left in the code',
    fix: 'Finish it, or tell the user in one line what is left to do.',
  },
  {
    id: 'unfinished:stub',
    cat: 'unfinished',
    level: 'block',
    // "not implemented" as an error or stub, not HTTP 501 responses or docs saying "implement this to ..."
    re: /^(?!.*\b501\b).*(?:\bnot (?:yet )?implemented\b|\bNotImplementedError\b|\bunimplemented!\s*\(|\btodo!\s*\(|\bimplement (?:me|later)\b|panic\(\s*["']todo)/i,
    text: 'Unfinished stub ("not implemented")',
    fix: 'Implement it, or tell the user it is unfinished.',
  },
  {
    id: 'unfinished:placeholder',
    cat: 'unfinished',
    level: 'warn',
    re: /\blorem ipsum\b|\bplaceholder (?:value|data|text|logic)\b|\bfake (?:data|user|response)\b|\bdummy (?:data|value|user)\b|\bhard-?coded for now\b/i,
    text: 'Placeholder or fake data',
    tests: 'skip',
  },
  {
    id: 'unfinished:debugger',
    cat: 'unfinished',
    level: 'block',
    re: /^\s*debugger;?\s*$|\bbreakpoint\(\)|\bpdb\.set_trace\(|\bbinding\.pry\b|\bbyebug\b|\bdd\(|\bvar_dump\(|\bdbg!\(/,
    text: 'Debugger statement left in',
    fix: 'Remove it.',
  },
  {
    id: 'unfinished:debug-print',
    cat: 'unfinished',
    level: 'warn',
    re: /\bconsole\.(?:log|debug|dir|table)\(|^\s*print\(|\bfmt\.Print(?:ln|f)?\(|\bSystem\.out\.print|\beprintln!\(/,
    text: 'Debug output (console.log / print) in source code',
    tests: 'skip',
  },

  // tests that stop protecting anything
  {
    id: 'tests:only',
    cat: 'tests',
    level: 'block',
    re: /\b(?:it|test|describe|context|suite)\.only\s*\(|\bf(?:it|describe)\s*\(/,
    text: 'Focused test (.only): every other test is skipped',
    fix: 'Remove .only.',
    tests: 'only',
  },
  {
    id: 'tests:skip',
    cat: 'tests',
    level: 'block',
    re: /\b(?:it|test|describe|context|suite)\.(?:skip|todo)\s*\(|\bx(?:it|describe|test)\s*\(|@pytest\.mark\.(?:skip|xfail)|@unittest\.skip|\bt\.Skip(?:Now|f)?\(|#\[ignore\]|@Disabled\b|@Ignore\b/,
    text: 'Test skipped',
    fix: 'Make it pass instead, or tell the user why it is skipped.',
    tests: 'only',
  },
  {
    id: 'tests:silenced-types',
    cat: 'tests',
    level: 'block',
    re: /@ts-(?:ignore|nocheck)\b|#\s*type:\s*ignore\b/,
    text: 'Type error silenced (@ts-ignore / type: ignore)',
    fix: 'Fix the type error, or tell the user why it has to be ignored.',
  },
  {
    id: 'tests:silenced-lint',
    cat: 'tests',
    level: 'warn',
    re: /eslint-disable|biome-ignore|oxlint-disable|#\s*noqa\b|#\s*pylint:\s*disable|\/\/\s*nolint\b|#\[allow\(|@SuppressWarnings/,
    text: 'Lint rule switched off',
  },

  // security
  {
    id: 'security:secret',
    cat: 'security',
    level: 'block',
    re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}|\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}|\bxox[abpors]-[A-Za-z0-9-]{10,}|\bAIza[0-9A-Za-z_-]{35}\b|\bsk_live_[0-9a-zA-Z]{20,}|\bnpm_[A-Za-z0-9]{36}\b/,
    text: 'Secret or API key written into the code',
    fix: 'Remove it and read it from an environment variable instead. If it was real, it should be rotated.',
  },
  {
    id: 'security:password',
    cat: 'security',
    level: 'block',
    re: /\b[\w-]*(?:password|passwd|secret|api_?key|apikey|access_?token|auth_?token|private_?key|client_?secret)\b["']?\s*[:=]\s*["'](?!(?:\$\{|\{\{|<|your|change|example|xxx|\*{3}|test|dummy|placeholder|redacted|process\.env))[^"'\s]{8,}["']/i,
    text: 'Hardcoded password or key',
    fix: 'Read it from an environment variable or config instead.',
    tests: 'skip',
  },
  {
    id: 'security:tls-off',
    cat: 'security',
    level: 'warn',
    re: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true|CURLOPT_SSL_VERIFYPEER|--insecure\b|\bcurl\s+-k\b/,
    text: 'TLS certificate checks turned off',
    tests: 'skip',
  },
  {
    id: 'security:cors-any',
    cat: 'security',
    level: 'warn',
    re: /Access-Control-Allow-Origin["']?\s*[:,]\s*["']\*|origin\s*:\s*["']\*["']|origin\s*:\s*true\b|allow_origins\s*=\s*\[\s*["']\*["']/,
    text: 'CORS opened to every site',
    tests: 'skip',
  },
  {
    id: 'security:eval',
    cat: 'security',
    level: 'warn',
    re: /\beval\s*\(|\bnew Function\s*\(|\bexec\s*\(\s*(?:f["']|["'][^"']*["']\s*\+|`[^`]*\$\{)|shell\s*=\s*True|\bpickle\.loads?\(|\byaml\.load\((?![^)]*Loader)|\bos\.system\(/,
    text: 'Runs code or shell commands built at runtime',
    tests: 'skip',
  },
  {
    id: 'security:sql',
    cat: 'security',
    level: 'warn',
    re: /["'`]\s*(?:SELECT|INSERT|UPDATE|DELETE)\b[^"'`]*["'`]\s*\+\s*\w|`\s*(?:SELECT|INSERT|UPDATE|DELETE)\b[^`]*\$\{|f["']\s*(?:SELECT|INSERT|UPDATE|DELETE)\b[^"']*\{/i,
    text: 'SQL built by joining strings (SQL injection risk)',
    tests: 'skip',
  },
  {
    id: 'security:html',
    cat: 'security',
    level: 'warn',
    re: /dangerouslySetInnerHTML|\.innerHTML\s*=|\bv-html\b|\|\s*safe\b|\bmark_safe\(|\bhtml_safe\b|bypassSecurityTrust/,
    text: 'Raw HTML inserted into the page (XSS risk)',
    tests: 'skip',
  },
]

const ASSERTION =
  /\bexpect\s*\(|\bassert(?:\.\w+|Equals?|That|True|False|_eq!?|_ne!?|!)?\s*[(\s]|\.should\b|\bself\.assert\w*\(|\brequire\.\w+\(|\bt\.(?:Error|Fatal)f?\(/

/**
 * The part of an assertion that says what is being checked, without the
 * expected value. `expect(sum(1, 2)).toBe(3)` -> `expect(sum(1, 2)).toBe(`
 * @param {string} line
 */
function assertionSubject(line) {
  const t = line.trim().replace(/;$/, '')
  // expect(x).toBe(y), expect(x).toEqual(y) ...
  let m = /^(.*\bexpect\s*\(.*\)\s*(?:\.\s*\w+\s*)*\.\s*\w+\s*\()(.*)\)$/.exec(t)
  if (m) return m[1]
  // assert.equal(a, b), assertEqual(a, b), assert_eq!(a, b)
  m = /^(.*\bassert\w*(?:\.\w+)?!?\s*\(\s*[^,]+,)(.*)\)$/.exec(t)
  if (m) return m[1]
  // assert a == b
  m = /^(assert\s+.+?\s*(?:==|!=|is not|is|in)\s*)(.+)$/.exec(t)
  if (m) return m[1]
  return null
}

/**
 * @param {string} line
 * @param {string} subject
 */
function expectedPart(line, subject) {
  const rest = line.trim().replace(/;$/, '').slice(subject.length).replace(/\)$/, '').trim()
  return rest.length > 30 ? `${rest.slice(0, 29)}…` : rest
}

/**
 * Scan what was added and removed for unfinished work, test tricks and security problems.
 * @param {import('../facts.mjs').Facts} f
 * @returns {Finding[]}
 */
export function scanContent(f) {
  /** @type {Map<string, { rule: Rule, where: string[] }>} */
  const hits = new Map()
  // a line that was only moved isn't new
  const removedTexts = new Set(f.hunks.flatMap((h) => h.removed.map((r) => r.text.trim())))

  for (const h of f.hunks) {
    if (isNoise(h.file) || isDoc(h.file)) continue
    const test = isTest(h.file)
    for (const a of h.added) {
      const text = a.text
      if (!text.trim() || removedTexts.has(text.trim())) continue
      for (const rule of LINE_RULES) {
        if (rule.tests === 'only' && !test) continue
        if (rule.tests === 'skip' && test) continue
        if (!rule.re.test(text)) continue
        const hit = hits.get(rule.id) ?? { rule, where: [] }
        hit.where.push(`${h.file}:${a.line}`)
        hits.set(rule.id, hit)
      }
    }
  }

  /** @type {Finding[]} */
  const out = []
  for (const { rule, where } of hits.values()) {
    out.push(grouped({ id: rule.id, cat: rule.cat, level: rule.level, text: rule.text, fix: rule.fix }, where))
  }
  out.push(...testIntegrity(f))
  out.push(...secretFiles(f))
  return out
}

/**
 * Tests that were deleted, weakened or had their expected values changed.
 * @param {import('../facts.mjs').Facts} f
 * @returns {Finding[]}
 */
function testIntegrity(f) {
  /** @type {Finding[]} */
  const out = []

  const deleted = f.files.filter((x) => x.status === 'D' && isTest(x.path)).map((x) => x.path)
  if (deleted.length) {
    out.push(
      grouped(
        {
          id: 'tests:deleted',
          cat: 'tests',
          level: 'block',
          text: 'Test file deleted',
          fix: 'Tell the user why these tests are no longer needed, or bring them back.',
        },
        deleted,
      ),
    )
  }

  /** @type {string[]} */
  const changed = []
  let removedAsserts = 0
  let addedAsserts = 0
  /** @type {string[]} */
  const removedWhere = []
  for (const h of f.hunks) {
    if (!isTest(h.file)) continue
    const fileDeleted = deleted.includes(h.file)
    const added = h.added.filter((l) => ASSERTION.test(l.text))
    const removed = h.removed.filter((l) => ASSERTION.test(l.text))
    if (!fileDeleted) {
      addedAsserts += added.length
      removedAsserts += removed.length
      if (removed.length) removedWhere.push(`${h.file}:${h.start}`)
    }
    // same assertion, different expected value
    for (const r of removed) {
      const subject = assertionSubject(r.text)
      if (!subject) continue
      const a = added.find((x) => assertionSubject(x.text) === subject && x.text.trim() !== r.text.trim())
      if (a) changed.push(`${h.file}:${a.line} (${expectedPart(r.text, subject)} → ${expectedPart(a.text, subject)})`)
    }
  }
  if (changed.length) {
    out.push(
      grouped(
        {
          id: 'tests:expectation-changed',
          cat: 'tests',
          level: 'block',
          text: 'Expected value in a test was changed',
          fix: 'If the behaviour is meant to change, tell the user why in one line. If you changed the test only to make it pass, change it back and fix the code.',
        },
        changed,
      ),
    )
  }
  const code = f.files.filter((x) => x.status !== 'D' && x.added > 0 && isCode(x.path)).map((x) => x.path)
  if (code.length && !f.files.some((x) => isTest(x.path))) {
    out.push(grouped({ id: 'tests:none-changed', cat: 'tests', level: 'warn', text: 'Code changed but no tests were added or changed' }, code))
  }
  if (removedAsserts > addedAsserts) {
    out.push(
      grouped(
        {
          id: 'tests:assertions-removed',
          cat: 'tests',
          level: removedAsserts - addedAsserts >= 3 ? 'block' : 'warn',
          text: `${removedAsserts - addedAsserts} assertion${removedAsserts - addedAsserts === 1 ? '' : 's'} removed from tests`,
          fix: 'Tell the user why these checks are no longer needed, or put them back.',
        },
        removedWhere,
      ),
    )
  }
  return out
}

/**
 * Env files with real values should never be part of a change.
 * @param {import('../facts.mjs').Facts} f
 * @returns {Finding[]}
 */
function secretFiles(f) {
  const files = f.files
    .filter((x) => x.status !== 'D')
    .map((x) => x.path)
    .filter((p) => /(^|\/)\.env(\.[\w-]+)?$/.test(p) && !/\.(example|sample|template|dist|defaults?)$/.test(p))
    .concat(f.files.filter((x) => x.status !== 'D' && /\.(pem|key|p12|pfx|keystore|jks)$|(^|\/)id_(rsa|ed25519|ecdsa)$/.test(x.path)).map((x) => x.path))
  if (!files.length) return []
  return [
    grouped(
      {
        id: 'security:secret-file',
        cat: 'security',
        level: 'block',
        text: 'File with secrets is part of the change',
        fix: 'Take it out of the change and add it to .gitignore.',
      },
      files,
    ),
  ]
}
