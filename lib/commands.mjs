// @ts-check

/**
 * Hide anything that looks like a secret before a command is written to disk.
 * @param {string} cmd
 */
export function maskSecrets(cmd) {
  return (
    cmd
      // FOO_TOKEN=abc, API_KEY="abc", password='abc'
      .replace(
        /\b([A-Za-z0-9_]*(?:key|token|secret|passw(?:or)?d|pwd|auth|credential|cookie|session)[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/gi,
        '$1=***',
      )
      // --token abc, --password=abc, -p abc is too ambiguous so it is left alone
      .replace(
        /(--?(?:[a-z0-9-]*(?:key|token|secret|passw(?:or)?d|auth|credential)[a-z0-9-]*))([= ])("[^"]*"|'[^']*'|\S+)/gi,
        '$1$2***',
      )
      // Authorization: Bearer abc
      .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***')
      // https://user:pass@host
      .replace(/(\w+:\/\/[^\s:/@]+):[^\s@/]+@/g, '$1:***@')
      // well known token formats
      .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, '***')
      .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '***')
      .replace(/\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{16,}/g, '***')
      .replace(/\bxox[abpors]-[A-Za-z0-9-]{10,}/g, '***')
      .replace(/\bAKIA[0-9A-Z]{16}\b/g, '***')
      .replace(/\bnpm_[A-Za-z0-9]{30,}/g, '***')
  )
}

/** @typedef {'test' | 'typecheck' | 'lint' | 'build'} CheckKind */

// each pattern must match at the start of a command step, so `cat vitest.config.ts` doesn't count
// options can come before the script name: `npm --prefix app test`, `pnpm -C app run lint`
const PM = String.raw`(?:npm|pnpm|yarn|bun)(?:\s+--?[\w-]+(?:=\S+|\s+(?!(?:run|test|lint|build|check|typecheck|type-check|tsc|types)\b)[^\s-]\S*)?)*\s+(?:run\s+)?`

/** @type {[CheckKind, RegExp][]} */
const CHECKS = [
  [
    'test',
    new RegExp(
      String.raw`^(?:${PM}test(?::\S+)?|vitest|jest|mocha|ava|playwright\s+test|cypress\s+run|bun\s+test|deno\s+test|node\s+(?:\S+\s+)*--test|pytest|py\.test|python3?\s+-m\s+(?:pytest|unittest)|tox|nox|go\s+test|cargo\s+(?:test|nextest)|mvn\w*\s+(?:\S+\s+)*(?:test|verify)|\S*gradlew?\s+(?:\S+\s+)*test|rspec|rake\s+test|phpunit|\S*pest|dotnet\s+test|swift\s+test|mix\s+test|ctest|make\s+(?:test|check))(?:\s|$)`,
    ),
  ],
  [
    'typecheck',
    new RegExp(
      String.raw`^(?:${PM}(?:typecheck|type-check|types|tsc|check-types)|tsc|vue-tsc|mypy|pyright|cargo\s+check|go\s+vet|flow\s+check)(?:\s|$)`,
    ),
  ],
  [
    'lint',
    new RegExp(
      String.raw`^(?:${PM}(?:lint|check)(?::\S+)?|eslint|biome\s+(?:check|lint|ci)|oxlint|ruff\s+check|flake8|pylint|golangci-lint|cargo\s+clippy|rubocop|stylelint|shellcheck|prettier\s+(?:\S+\s+)*(?:--check|-c))(?:\s|$)`,
    ),
  ],
  [
    'build',
    new RegExp(
      String.raw`^(?:${PM}build(?::\S+)?|cargo\s+build|go\s+build|mvn\w*\s+(?:\S+\s+)*package|\S*gradlew?\s+(?:\S+\s+)*build|dotnet\s+build|swift\s+build|make)(?:\s|$)`,
    ),
  ],
]

// things that run another command: `npx vitest`, `FOO=1 pnpm test`, `timeout 60 cargo test`
const WRAPPER =
  /^(?:\w+=(?:"[^"]*"|'[^']*'|\S*)\s+|(?:npx|pnpx|bunx|pnpm\s+exec|yarn\s+exec|uv\s+run|poetry\s+run|pipenv\s+run|time|nice|env|sudo|command|exec)\s+(?:-\S+\s+)*|timeout\s+\S+\s+)/

/**
 * Split a shell command into its steps (`a && b; c | d`), unwrapping `bash -c "..."`.
 * Not a real shell parser, just good enough for the commands agents run.
 * @param {string} cmd
 */
export function commandSteps(cmd) {
  const unwrapped = cmd.replace(/\b(?:ba|z)?sh\s+-l?c\s+(["'])((?:\\.|(?!\1).)*)\1/g, (_m, _q, inner) => ` ; ${inner} ; `)
  // blank out the rest of the quoted text so `echo "a | npm test"` isn't split in the middle
  const plain = unwrapped.replace(/(["'])(?:\\.|(?!\1).)*\1/g, '""')
  const steps = []
  for (let step of plain.split(/&&|\|\||[;|\n]/)) {
    // `(cd app && npm test)` and `{ npm test; }` are still commands
    step = step.trim().replace(/^[({]\s*/, '').replace(/\s*[)}]$/, '')
    // leading "cd dir" is its own step already; strip wrappers until none are left
    let prev
    do {
      prev = step
      step = step.replace(WRAPPER, '')
    } while (step !== prev)
    if (step) steps.push(step)
  }
  return steps
}

/**
 * Which kinds of check a shell command runs (`npm run build && npm test` is both).
 * @param {string} cmd
 * @returns {CheckKind[]}
 */
export function checkKinds(cmd) {
  /** @type {Set<CheckKind>} */
  const kinds = new Set()
  for (const step of commandSteps(cmd)) {
    for (const [kind, re] of CHECKS) {
      if (re.test(step)) {
        kinds.add(kind)
        break
      }
    }
  }
  return [...kinds]
}

/**
 * Short form of a command for display: first line, trimmed, max 120 chars.
 * @param {string} cmd
 */
export function shortCommand(cmd) {
  const first = cmd.trim().split('\n')[0]
  const more = cmd.trim().includes('\n') ? ' …' : ''
  return first.length > 120 ? `${first.slice(0, 117)}...` : first + more
}

/**
 * Try to read "how many tests passed/failed" from common test runner output.
 * Only the numbers are kept, never the output itself.
 * @param {string} out
 * @returns {{ passed?: number, failed?: number } | undefined}
 */
export function testCounts(out) {
  if (!out) return undefined
  const text = out.slice(-20000)
  /** @type {[RegExp, RegExp | null][]} */
  const patterns = [
    // vitest: "Tests  69 passed (69)" / "Tests  2 failed | 67 passed (69)"
    [/Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed/, null],
    // jest: "Tests:       1 failed, 41 passed, 42 total"
    [/Tests:\s+(?:(\d+)\s+failed,\s*)?(\d+)\s+passed/, null],
    // node --test: "# pass 12" / "# fail 0"
    [/^# pass (\d+)/m, /^# fail (\d+)/m],
    // pytest: "== 1 failed, 12 passed in 0.31s =="
    [/(?:(\d+) failed, )?(\d+) passed(?:,| in )/, null],
    // cargo: "test result: ok. 12 passed; 0 failed"
    [/test result: \w+\. (\d+) passed; (\d+) failed/, null],
  ]
  for (const [re, failRe] of patterns) {
    const m = re.exec(text)
    if (!m) continue
    if (failRe) {
      const f = failRe.exec(text)
      return { passed: Number(m[1]), failed: f ? Number(f[1]) : 0 }
    }
    if (re.source.startsWith('test result')) return { passed: Number(m[1]), failed: Number(m[2]) }
    return { passed: Number(m[2]), failed: m[1] ? Number(m[1]) : 0 }
  }
  return undefined
}
