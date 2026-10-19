# receipts

Make your AI coding agent show its work.

When an agent says "done, all tests pass", you usually have to take its word for it, or scroll back through the session to check. Receipts records what the agent actually did and turns it into a short note you can read in 30 seconds or paste into a PR:

```markdown
## Receipt: add rate limiting to /login

**Changed:** 3 files (+84 −12): `src/auth.ts`, `src/limits.ts` (new), `test/auth.test.ts`

**Verified** (recorded, not claimed):
- ✅ `npm test`: passed (42 passed)
- ⚠️ `npm run typecheck`: passed, **but the code changed after it ran**
- ⚠️ `npm run lint`: never run

**Why:** login had no limit, so password guessing was unlimited.
**Assumed:** the app runs as one server, so the counter is kept in memory.
**Rejected:** a Redis store, it adds a dependency for a single server.
**Not checked:** how it behaves behind a proxy (IP detection).

**Look closely at:**
- src/limits.ts:22-40 (time window logic)
- 🚩 auth / security changed: src/auth.ts
```

The top half is evidence. It comes from what really happened, not from what the agent says happened, so a test that never ran shows up as never run, and a test that ran before the last edit shows up as stale.

The bottom half is the part only the agent knows: why it did it, what it assumed, what it skipped. That's exactly the stuff that's missing when you review AI-written code.

## Install (Claude Code)

```
/plugin marketplace add Harshavardhan-Sondakar/receipts
/plugin install receipts@receipts
```

Restart Claude Code, then work as usual. When a task is done, ask:

> make a receipt

The receipt is saved to `.receipts/latest.md` in your project. To use it as a PR description:

```sh
gh pr create --body-file .receipts/latest.md
```

You need Node.js 20 or newer and git 2.31 or newer.

## How it works

1. **A hook records every command and file edit.** It's a small script that runs after each tool call and writes one line to `.receipts/log.jsonl`. It prints nothing, so it adds nothing to the agent's context and costs no tokens.
2. **A script turns the log into facts.** It compares your project now with how it was when the session started, using git. That's how it knows which files changed (even ones changed by a shell command), which checks passed or failed, and whether the code changed after a check ran.
3. **The agent adds a few lines.** Only the things a script can't know: why, assumptions, rejected options, what wasn't checked, where to look.

### Red flags it looks for

All of these are found by plain code, no AI:

- a test or check that ran before the last change (stale)
- project checks that never ran (`test`, `lint`, `typecheck` from your `package.json`, or `cargo test`, `go test`, `pytest`)
- `.only` or skipped tests, `@ts-ignore`, `eslint-disable` and similar in new lines
- deleted test files, or lots of test lines removed
- new dependencies (`package.json`, `requirements.txt`, `go.mod`)
- changes to auth, env files, CI config, migrations or infrastructure
- code changed but no test files touched
- risky commands like `git push --force`, `git reset --hard`, `--no-verify`, `npm publish`

## Token cost

Measured with `claude plugin details`:

| | tokens |
|---|---|
| Always loaded (the skill's one-line description) | ~72 |
| Hooks | 0 (they never talk to the model) |
| Making a receipt (skill instructions) | ~390 |
| Facts the agent reads | ~100 to 300 |
| What the agent writes | ~100 to 200 |

So roughly **700 tokens per receipt**, and nothing while the agent works. The main trick is that the agent never re-reads the diff or the conversation to write the receipt. The script already did that.

## Privacy

Everything stays on your machine in `.receipts/`, which ignores itself in git (it has its own `.gitignore`), so it never ends up in a commit.

- Command output is never saved. Only the pass/fail result and test counts are kept.
- Things that look like secrets in commands (`API_KEY=...`, `--token ...`, `Bearer ...`, `https://user:pass@...`, GitHub/npm/AWS/Slack tokens) are replaced with `***` before anything is written.
- Your git staging area is never touched. Snapshots use a temporary index.

## CLI

The plugin uses these, but you can run them yourself too:

```sh
npx show-receipts facts   # what was recorded for the current task
npx show-receipts show    # print the latest receipt
```

## Other agents

Codex and Cursor both have hooks, and the recorder already understands their payloads, but they aren't packaged or tested yet. That's next. If you want to try it early, open an issue and I'll help you set it up.

Cursor's shell hook doesn't report exit codes, so there receipts will show "ran" instead of "passed" or "failed" unless it can read test counts from the output.

## Limits

- It knows what ran, not whether the tests are any good. A passing test suite with no real tests still passes.
- Outside a git repo it can only list files changed through the agent's edit tool, and can't tell if a check is stale after shell edits.
- If you install it in the middle of a session, the first task is compared with your last commit, so your own uncommitted changes may show up too. The receipt says so when this happens.

## License

MIT
