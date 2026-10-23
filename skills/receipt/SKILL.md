---
name: receipt
description: Write a short receipt of the work you just did, with recorded proof of which checks really ran and what needs a human look. Use when finishing a coding task, before a commit or PR, or when asked for a receipt.
---

Hooks already recorded the changes and commands, and plain-code checks looked for problems. You add only what they can't know. Run the CLI from the project folder (don't cd into the skill folder), using its full path: `<skill folder>/../../bin/receipts.mjs`.

1. `node "<skill folder>/../../bin/receipts.mjs" facts` (don't repeat these, they're added for you)
2. If it lists a `Problem`, fix it first, or explain it under `notes`.
3. Write your part:

```sh
node "<skill folder>/../../bin/receipts.mjs" write <<'EOF'
title: <task in a few words>
why: <the problem>
assumed: <a guess that could be wrong>
rejected: <option skipped, and why>
not checked: <what you didn't verify>
look at: <file:line> <why>
EOF
```

- One short line per item, max 3 per key. Skip keys with nothing real. No filler.
- Never claim a pass the facts don't show.
- If nothing was recorded, add a `ran:` line per check you ran, with its real result.
- Don't re-read the diff or the receipt. Then give the user the file path in one line.
