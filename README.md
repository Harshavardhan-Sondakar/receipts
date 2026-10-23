# receipts

Your AI coding agent says "done, all tests pass". Receipts checks if that's true.

It runs next to Claude Code, Codex or Cursor. When the agent tries to finish, Receipts looks at what really happened: which commands ran, what changed, what the agent claims. If something is off, the agent is sent back to fix it before you ever see it. When it's done, you get a short summary and know exactly which lines are worth your time.

No AI is used for any of the checks. It's plain code, so it's fast (about 150 ms on a large repo) and costs no tokens unless there's something to fix.

## What it catches

**Work that isn't verified**
- tests, typecheck or lint that never ran on the final code
- checks that failed, or ran before the last change
- results hidden by a pipe, like `npm test | tail` (the exit code is `tail`'s, not the tests')

**Claims that don't match what happened**
- "All tests pass" when they didn't run, failed, or ran on older code
- "I added tests" when no test file changed
- "Updated the README" when no doc changed
- "No breaking changes" when an export or API route was removed
- "No new dependencies" when one was added
- "All 72 tests pass" when the last run had 70

**Tricks to make things pass**
- `.only` or `.skip` added to tests, or test files deleted
- the expected value in a test changed (`toBe(3)` became `toBe(4)`)
- assertions removed from tests
- `@ts-ignore`, `# type: ignore`, `eslint-disable`

**Unfinished work**
- new `TODO` / `FIXME`, "not implemented" stubs
- `debugger`, `breakpoint()`, leftover `console.log` / `print`
- placeholder or fake data

**Security**
- API keys, tokens and passwords written into code
- `.env` files or private keys added to the change
- TLS checks turned off, CORS open to everyone, `eval`, SQL built from strings, raw HTML

**Fake or risky packages**

AI tools sometimes invent package names, and attackers register those names ("slopsquatting"). Every new dependency in `package.json`, `requirements.txt`, `pyproject.toml` or `go.mod` is checked:
- doesn't exist on npm / PyPI
- one letter away from a popular package but barely used (`lodahs` vs `lodash`)
- published days ago, or almost no downloads

**Things outside the task**
- files edited outside the project, global installs, `curl | sh`, `sudo`
- `git push --force`, `git reset --hard`, `--no-verify`, `npm publish`
- deleted files, migrations that drop tables or columns
- changes to auth, payments, CI, infrastructure

**Breaking changes**
- exported functions or API routes removed
- a new environment variable that isn't in `.env.example`

Things the agent can fix (missing checks, false claims, TODOs, secrets, test tricks, fake packages) send it back. The rest is shown to you as "worth a look".

## What you see

When the agent finishes, a summary appears in Claude Code. It's shown to you only, so it costs no tokens:

```
🧾 3 files changed · tests ✅ 72 · typecheck ✅ · lint ✅
   ⚠️ Dependencies: 1 new dependency (`zod`)
   👀 Review: read 12 lines in 1 file · skim 30 (tests) · skip 180 (lockfile, whitespace only) · start at src/limits.ts:22-33
```

If something's wrong, the agent gets a short note instead and keeps working:

```
Receipts: not done yet. Fix these, or tell the user why they're fine:
- Lint never ran on these changes. Run `npm run lint`.
- You said you added tests, but no test file has new lines. Make it true (run it or do it), or correct what you told the user.
```

Each problem sends the agent back at most once, and at most twice per task, so it can't get stuck in a loop.

Ask "make a receipt" for the full version, ready to paste into a PR. A real one:

```markdown
## Receipt: Reject NaN for limits.fileSize

**Changed:** 2 files (+9 −0): `src/middleware.ts`, `test/middleware.test.ts`

**Verified** (recorded, not claimed):
- ✅ `npm test 2>&1 | tail -30`: passed (72 passed)
- ⚠️ `npm run typecheck`: never run
- ⚠️ `npm run lint`: never run

**Why:** NaN slipped past the `< 0` check, so an invalid fileSize was silently accepted.
**Rejected:** Number.isFinite check, because Infinity may be a legitimate "no limit" value.
**Not checked:**
- Other limits (e.g. file count) may have the same NaN gap; I did not look.

**Look closely at:**
- src/middleware.ts:41 new NaN guard placed before the negative check.
```

That one is from a real Claude Code session on [hono-file-upload](https://github.com/Harshavardhan-Sondakar/hono-file-upload), made with an earlier version (today's version would also have sent the agent back to run typecheck and lint).

## Install

You need Node.js 20+ and git 2.31+.

### Claude Code

```sh
claude plugin marketplace add Harshavardhan-Sondakar/receipts
claude plugin install receipts@receipts
```

Restart Claude Code and work as usual. To update later: `claude plugin marketplace update receipts && claude plugin update receipts@receipts`.

### Codex and Cursor (beta)

From your project folder:

```sh
npx show-receipts init codex    # or: init cursor   (add --global for all projects)
```

This adds hooks to `.codex/hooks.json` or `.cursor/hooks.json` (merged with what's there) and short receipt instructions to `AGENTS.md` or `.cursor/rules/`. Codex asks you to approve new hooks on its next start.

These two are tested against their documented hook formats but haven't been through as many real sessions as Claude Code yet. Cursor doesn't report exit codes, so a check there counts as passed only when its output has a test summary. Please open an issue if something looks off.

### In CI or before a commit

```sh
npx show-receipts check --base origin/main   # exit code 1 if something must be fixed
npx show-receipts check --json               # for scripts
```

Without the agent's recording, CI can't know which checks ran, but everything else (secrets, test tricks, fake packages, TODOs, breaking changes, review map) works the same.

## Settings

Optional. Put them in `receipts.json` in your project, or under `"receipts"` in `package.json`:

```json
{
  "mode": "enforce",
  "require": ["test", "typecheck", "lint"],
  "commands": { "test": "make verify" },
  "ignore": ["unfinished:debug-print", "deps"],
  "sensitive": ["src/billing/"],
  "maxBlocks": 2,
  "registry": true
}
```

- `mode`: `enforce` sends the agent back, `warn` only tells you, `off` turns the stop check off. `RECEIPTS_MODE=warn` works too.
- `require`: which checks must run on the final code (only the ones your project has).
- `commands`: your own check commands, if they aren't `package.json` scripts.
- `ignore`: finding ids (`tests:silenced-lint`), prefixes, or whole categories (`deps`, `security`, ...).
- `sensitive`: extra paths to flag when changed.
- `registry`: set to `false` to never look packages up online. `RECEIPTS_OFFLINE=1` does the same.

## Token cost

Measured with `claude plugin details`:

| | tokens |
|---|---|
| Always loaded (the skill's one-line description) | ~79 |
| Recording commands and edits | 0 (hooks never talk to the model) |
| The check when the agent stops | 0, unless it sends the agent back (~50–150 for the note) |
| The summary you see | 0 (shown to you only) |
| A full receipt, when you ask for one | ~400 for the instructions, plus ~300–500 for facts and the agent's notes |

The agent never re-reads the diff or the conversation for any of this. The script already has it.

## Privacy

Everything stays on your machine in `.receipts/`, which ignores itself in git, so it never ends up in a commit.

- Command output is never saved, only pass/fail and test counts.
- Things that look like secrets in commands (`API_KEY=...`, `--token ...`, `Bearer ...`, `https://user:pass@...`, GitHub/npm/AWS/Slack tokens) are replaced with `***` before anything is written.
- Your git staging area is never touched.
- The only network calls are package lookups on npm / PyPI for new dependencies, cached for a week. Turn them off with `"registry": false`.

## Limits

- It knows what ran, not whether the tests are good. A test suite with no real tests still passes.
- Claim checking reads plain English and looks for clear claims ("all tests pass", "added tests"). It ignores negations and instructions ("make sure tests pass"), and won't catch everything.
- Checks look at lines, not code meaning, so a TODO inside a string counts and an export removed through a re-export might not.
- Outside a git repo it can only list files changed through the agent's edit tool.
- If you install it mid-session, the first task is compared with your last commit, so your own uncommitted changes may show up too. The receipt says so when this happens.

## License

MIT
