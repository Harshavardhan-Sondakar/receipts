---
name: receipt
description: Write a short receipt of the work you just did, with recorded proof of which checks really ran. Use when finishing a coding task, before a commit or PR, or when asked for a receipt.
---

Hooks already recorded the changes and commands. You add only what they can't know. The CLI is `../../bin/receipts.mjs` from this skill's folder.

1. `node <skill folder>/../../bin/receipts.mjs facts` (don't repeat these, they're added for you)
2. Write your part:

```sh
node <skill folder>/../../bin/receipts.mjs write <<'EOF'
title: <task in a few words>
why: <the problem>
assumed: <a guess that could be wrong>
rejected: <option skipped, and why>
not checked: <what you didn't verify>
look at: <file:line> <why>
EOF
```

- One short line per item, max 3 per key. Skip keys with nothing real. No filler.
- If a check failed, never ran, or ran before your last change: run it now or put it under `not checked`. Never claim a pass the facts don't show.
- `look at`: 1 to 3 places to review first. Use "Biggest changes" for line numbers.
- If nothing was recorded, add a `ran:` line per check you ran, with its real result.
- Don't re-read the diff or the receipt. Then give the user the file path in one line.
