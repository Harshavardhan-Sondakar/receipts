// @ts-check
import { isDoc, isTest } from '../paths.mjs'

/**
 * @typedef {import('../facts.mjs').Facts} Facts
 * @typedef {import('../findings.mjs').Finding} Finding
 */

// words right before a claim that turn it into "not a claim"
const NEGATION = /\b(?:not|never|no longer|without|unable|couldn't|could not|didn't|did not|haven't|have not|hasn't|wasn't|weren't|isn't|aren't|don't|can't|cannot|won't)\b[^.!?]*$/i
// "make sure tests pass", "once the build succeeds": instructions or conditions, not claims
const NOT_A_CLAIM = /\b(?:if|once|when|until|unless|make sure|ensure|should|please|need to|needs to|to make|try to|so that|whether|might|may|will)\b[^.!?]*$/i

/**
 * @typedef {{ name: string, re: RegExp, check: (f: Facts, others: Finding[], match: RegExpExecArray) => string | null, level?: 'block' | 'warn' }} Claim
 */

/** @type {Claim[]} */
const CLAIMS = [
  {
    name: 'tests-pass',
    re: /\b(?:all\s+)?(?:(\d+)\s+)?(?:of\s+the\s+)?(?:the\s+)?(?:unit\s+|integration\s+|e2e\s+|existing\s+|new\s+)?tests?\s+(?:are\s+|now\s+|still\s+|all\s+)*(?:pass(?:es|ing|ed)?|green|succeed(?:s|ed)?)\b|\b(\d+)\s+(?:tests?\s+)?passed\b|\btest suite\s+(?:is\s+|now\s+)*(?:passing|green|passes)\b/i,
    check: (f) => checkResult(f, 'test', 'the tests pass'),
  },
  {
    name: 'test-count',
    re: /\b(?:all\s+)?(\d+)\s+(?:tests?\s+)?(?:pass(?:es|ing|ed)?|green)\b|\b(\d+)\s+(?:tests?\s+)?passed\b/i,
    level: 'warn',
    check: (f, _o, m) => {
      const said = Number(m[1] ?? m[2])
      const last = lastRun(f, 'test')
      const real = last?.counts?.passed
      if (!real || !said || said === real) return null
      return `you said ${said} tests pass, but the last recorded run had ${real} passing`
    },
  },
  {
    name: 'typecheck',
    re: /\b(?:type ?check(?:ing)?|tsc|types?|mypy|pyright)\s+(?:is\s+|are\s+|now\s+|still\s+)*(?:pass(?:es|ing|ed)?|clean|green|succeed(?:s|ed)?)\b|\bno type errors\b/i,
    check: (f) => checkResult(f, 'typecheck', 'the typecheck passes'),
  },
  {
    name: 'lint',
    re: /\b(?:lint(?:ing|er)?|eslint|biome|ruff|clippy)\s+(?:is\s+|now\s+|still\s+)*(?:pass(?:es|ing|ed)?|clean|green)\b|\bno lint(?:ing)?\s+(?:errors|warnings|issues)\b/i,
    check: (f) => checkResult(f, 'lint', 'lint passes'),
  },
  {
    name: 'build',
    re: /\bbuild(?:s)?\s+(?:is\s+|now\s+|still\s+)*(?:pass(?:es|ing|ed)?|succeed(?:s|ed)?|green|works)\b|\bbuil(?:d|t)\s+successfully\b|\bcompiles?\s+(?:cleanly|successfully|fine|without errors)\b/i,
    check: (f) => checkResult(f, 'build', 'the build succeeds'),
  },
  {
    name: 'added-tests',
    re: /\b(?:added|wrote|written|created|adds)\s+(?:a\s+|an\s+|some\s+|\d+\s+|new\s+|more\s+|unit\s+|regression\s+|integration\s+|e2e\s+)*(?:test|tests|test case|test cases|specs?)\b/i,
    check: (f) =>
      f.git && !f.files.some((x) => isTest(x.path) && x.added > 0)
        ? 'you said you added tests, but no test file has new lines'
        : null,
  },
  {
    name: 'updated-docs',
    re: /\b(?:updated|update|added to|documented|documents)\s+(?:it\s+in\s+|this\s+in\s+)?(?:the\s+)?(readme|docs|documentation|changelog)\b/i,
    check: (f) =>
      f.git && !f.files.some((x) => isDoc(x.path) || /readme|changelog/i.test(x.path))
        ? 'you said you updated the docs, but no doc file changed'
        : null,
  },
  {
    name: 'no-breaking',
    re: /\bno breaking changes?\b|\bbackwards?[- ]compatible\b|\bnon-breaking\b|\bdoesn't break\b/i,
    check: (_f, others) => {
      const breaking = others.filter((o) => o.cat === 'breaking')
      return breaking.length ? `you said there are no breaking changes, but ${breaking.map((b) => b.text).join('; ')}` : null
    },
  },
  {
    name: 'no-new-deps',
    re: /\bno new dependenc(?:y|ies)\b|\bwithout (?:adding )?(?:any )?(?:new )?dependenc(?:y|ies)\b/i,
    check: (_f, others) => {
      const deps = others.filter((o) => o.id.startsWith('deps:new'))
      return deps.length ? `you said no new dependencies, but ${deps.map((d) => d.where ?? d.text).join(', ')} ${deps[0].text.startsWith('1 ') ? 'was' : 'were'} added` : null
    },
  },
]

/**
 * @param {Facts} f
 * @param {string} kind
 */
function lastRun(f, kind) {
  return f.checks.filter((c) => c.kinds.includes(kind)).sort((a, b) => b.at - a.at)[0]
}

/**
 * @param {Facts} f
 * @param {string} kind
 * @param {string} claim
 */
function checkResult(f, kind, claim) {
  if (!f.recorded) return null
  const last = lastRun(f, kind)
  if (!last) return `you said ${claim}, but it never ran in this task`
  if (last.ok === false) return `you said ${claim}, but the last run failed: \`${last.cmd}\``
  if (last.ok === null) return `you said ${claim}, but the result of \`${last.cmd}\` wasn't recorded (${last.note ?? 'unknown'})`
  if (last.stale) return `you said ${claim}, but it last ran before your final code changes`
  return null
}

/**
 * Split into sentences, keeping "1.5" and "e.g." together well enough.
 * Code blocks are dropped, they're not claims.
 * @param {string} text
 */
function sentences(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9*`-])|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Compare what the agent said in its final message with what was recorded.
 * @param {string | undefined} message
 * @param {Facts} f
 * @param {Finding[]} others findings from the other checks
 * @returns {Finding[]}
 */
export function checkClaims(message, f, others) {
  if (!message) return []
  /** @type {Finding[]} */
  const out = []
  const done = new Set()
  for (const sentence of sentences(message)) {
    if (sentence.endsWith('?')) continue
    for (const claim of CLAIMS) {
      if (done.has(claim.name)) continue
      const m = claim.re.exec(sentence)
      if (!m) continue
      const before = sentence.slice(0, m.index)
      if (NEGATION.test(before) || NOT_A_CLAIM.test(before) || /\b(?:fail|failing|broken|red)\b/i.test(sentence)) continue
      done.add(claim.name)
      const problem = claim.check(f, others, m)
      if (!problem) continue
      out.push({
        id: `claims:${claim.name}`,
        cat: 'claims',
        level: claim.level ?? 'block',
        text: problem.charAt(0).toUpperCase() + problem.slice(1),
        fix: 'Make it true (run it or do it), or correct what you told the user.',
      })
    }
  }
  return out
}
