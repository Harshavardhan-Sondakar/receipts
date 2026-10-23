// @ts-check
import { grouped } from '../findings.mjs'
import { isNoise, isTest } from '../paths.mjs'

/**
 * @typedef {import('../facts.mjs').Facts} Facts
 * @typedef {import('../findings.mjs').Finding} Finding
 */

/** @type {[string, RegExp, string][]} */
const RISKY_COMMANDS = [
  ['force-push', /\bgit\s+push\b.*\s(?:--force(?:-with-lease)?|-f)\b/, 'Force push'],
  ['reset-hard', /\bgit\s+reset\s+--hard\b/, 'git reset --hard (throws away changes)'],
  ['git-clean', /\bgit\s+clean\s+-\w*f/, 'git clean (deletes untracked files)'],
  ['discard', /\bgit\s+(?:checkout|restore)\s+(?:--\s+)?\.(?:\s|$)/, 'Discarded local changes'],
  ['no-verify', /\s--no-verify\b/, 'Skipped git hooks (--no-verify)'],
  ['history', /\bgit\s+(?:rebase|filter-branch|filter-repo)\b|\bgit\s+commit\s+.*--amend\b/, 'Rewrote git history'],
  ['rm-rf', /\brm\s+-\w*r\w*f?\s+(?!(?:\.\/)?(?:node_modules|dist|build|coverage|\.next|target|__pycache__|tmp|\.cache|\.turbo)\b)/, 'Recursive delete'],
  ['publish', /\b(?:npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bgem\s+push\b/, 'Published a package'],
  ['drop-data', /\b(?:drop\s+(?:table|database|schema)|truncate\s+table)\b/i, 'Dropped data'],
  ['infra', /\b(?:terraform|tofu)\s+(?:apply|destroy)\b|\bkubectl\s+(?:delete|apply)\b|\bhelm\s+(?:install|upgrade|uninstall)\b|\bpulumi\s+(?:up|destroy)\b/, 'Changed live infrastructure'],
  ['global-install', /\b(?:npm|pnpm)\s+(?:i|install|add)\s+(?:.*\s)?(?:-g|--global)\b|\byarn\s+global\s+add\b|\bcargo\s+install\b|\bbrew\s+install\b|\b(?:apt|apt-get|dnf|yum|pacman)\s+(?:-\w+\s+)*install\b|\bpip3?\s+install\b.*\s--user\b/, 'Installed software outside the project'],
  ['global-config', /\bgit\s+config\s+--global\b|>>?\s*~\/\.\w+|>>?\s*\$HOME\/\.\w+|>\s*\/etc\//, 'Changed your global settings'],
  ['sudo', /(?:^|[;&|]\s*)sudo\s/, 'Ran a command as root (sudo)'],
  ['pipe-to-shell', /\b(?:curl|wget)\b[^|]*\|\s*(?:ba|z)?sh\b/, 'Downloaded and ran a script (curl | sh)'],
  ['chmod-777', /\bchmod\s+(?:-R\s+)?777\b/, 'chmod 777'],
]

// paths where a small change can matter a lot
/** @type {[RegExp, string][]} */
const SENSITIVE = [
  [/(^|\/)\.github\/workflows\/|(^|\/)\.gitlab-ci\.ya?ml$|(^|\/)\.circleci\/|(^|\/)Jenkinsfile$|(^|\/)azure-pipelines\.ya?ml$/i, 'CI config'],
  [/(^|\/)(Dockerfile|docker-compose[^/]*\.ya?ml|compose\.ya?ml)$/i, 'Container config'],
  [/\.tf$|(^|\/)(k8s|kubernetes|helm|charts|terraform|infra)\//i, 'Infrastructure'],
  [/(^|\/)(migrations?|migrate|db\/migrate)\/|\.sql$/i, 'Database migration'],
  [/(^|[/._-])(auth|authn|authz|authentication|authorization|authorize|login|logout|session|sessions|passwords?|permissions?|roles?|rbac|acl|crypto|security|secrets?|tokens?|oauth|jwt|csrf|cors|sso|saml)([/._-]|$)/i, 'Auth / security code'],
  [/(^|[/._-])(payments?|billing|checkout|invoices?|stripe|charges?|refunds?|subscriptions?|wallet|ledger)([/._-]|$)/i, 'Payments code'],
  [/(^|\/)(\.npmrc|\.yarnrc\.yml|\.pypirc|\.gitattributes|CODEOWNERS)$/, 'Repo settings'],
]

/**
 * Things the agent did beyond the code itself.
 * @param {Facts} f
 * @returns {Finding[]}
 */
export function checkScope(f) {
  /** @type {Finding[]} */
  const out = []

  for (const [id, re, label] of RISKY_COMMANDS) {
    const cmds = [...new Set(f.runs.filter((r) => re.test(r.cmd)).map((r) => `\`${r.cmd}\``))]
    if (cmds.length) out.push(grouped({ id: `scope:cmd-${id}`, cat: 'scope', level: 'warn', text: `Ran a risky command: ${label}` }, cmds))
  }

  const outside = [...new Set(f.edits.map((e) => e.file).filter((p) => p.startsWith('..') || p.startsWith('/')))]
  if (outside.length) out.push(grouped({ id: 'scope:outside', cat: 'scope', level: 'warn', text: 'Edited files outside the project' }, outside))

  const deleted = f.files.filter((x) => x.status === 'D' && !isTest(x.path) && !isNoise(x.path)).map((x) => x.path)
  if (deleted.length) out.push(grouped({ id: 'scope:deleted', cat: 'scope', level: 'warn', text: `Deleted ${deleted.length} file${deleted.length === 1 ? '' : 's'}` }, deleted))

  const added = f.files.reduce((n, x) => n + (isNoise(x.path) ? 0 : x.added), 0)
  const removed = f.files.reduce((n, x) => n + (isNoise(x.path) ? 0 : x.removed), 0)
  if (removed > 300 && removed > added * 2) {
    out.push({ id: 'scope:big-delete', cat: 'scope', level: 'warn', text: `Removed ${removed} lines (added ${added})` })
  }

  // migrations that throw data away
  const drops = []
  for (const h of f.hunks) {
    if (!/(^|\/)(migrations?|migrate|db\/migrate|alembic)\/|\.sql$/i.test(h.file)) continue
    for (const a of h.added) {
      if (/\bdrop\s+(?:table|column|database|schema)\b|\btruncate\b|\b(?:dropTable|dropColumn|removeColumn|remove_column|drop_table|drop_column|dropIndex)\b|\bop\.drop_/i.test(a.text)) {
        drops.push(`${h.file}:${a.line}`)
      }
    }
  }
  if (drops.length) out.push(grouped({ id: 'scope:migration-drop', cat: 'scope', level: 'warn', text: 'Migration deletes a table or column (data loss)' }, drops))

  /** @type {Map<string, string[]>} */
  const sensitive = new Map()
  const custom = f.config.sensitive.map((p) => [p, 'Marked sensitive in receipts.json'])
  for (const x of f.files) {
    if (isTest(x.path)) continue
    const hit =
      SENSITIVE.find(([re]) => re.test(x.path)) ??
      /** @type {[string, string] | undefined} */ (custom.find(([p]) => x.path.startsWith(p)))
    if (hit) sensitive.set(hit[1], [...(sensitive.get(hit[1]) ?? []), x.path])
  }
  for (const [label, paths] of sensitive) {
    out.push(grouped({ id: `scope:sensitive-${label.toLowerCase().replace(/\W+/g, '-')}`, cat: 'scope', level: 'warn', text: `${label} changed` }, paths))
  }
  return out
}
