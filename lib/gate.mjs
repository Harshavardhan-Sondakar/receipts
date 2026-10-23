// @ts-check
import { analyze } from './analyze.mjs'
import { collectFacts } from './facts.mjs'
import { blockReason, userSummary } from './render.mjs'
import { append, currentTask, projectRoot, readLog } from './store.mjs'

/**
 * @typedef {import('./store.mjs').GateEvent} GateEvent
 * @typedef {'claude' | 'codex' | 'cursor'} Agent
 */

/**
 * Which agent sent this stop event. They all stop slightly differently.
 * @param {any} input
 * @returns {Agent}
 */
export function agentOf(input) {
  if (input.hook_event_name === 'stop' || input.cursor_version || input.conversation_id) return 'cursor'
  if (input.turn_id) return 'codex'
  return 'claude'
}

/**
 * Runs when the agent is about to say it's done.
 * Returns the JSON the agent expects on stdout, or null for "carry on".
 * @param {any} input the Stop hook payload
 * @returns {Promise<object | null>}
 */
export async function gate(input) {
  const cwd = typeof input.cwd === 'string' ? input.cwd : input.workspace_roots?.[0]
  const root = projectRoot(cwd)
  const agent = agentOf(input)
  const session = String(input.session_id ?? input.conversation_id ?? 'default')

  const f = collectFacts(root)
  if (f.config.mode === 'off' || !f.recorded || !f.files.length) return null

  const { events } = currentTask(readLog(root))
  const gates = /** @type {GateEvent[]} */ (events.filter((e) => e.t === 'gate'))
  const last = gates.at(-1)
  // nothing changed since we last looked (e.g. the user just asked a question): stay quiet
  if (last && last.tree === f.tree && !input.stop_hook_active && agent !== 'cursor') return null

  const { findings, review } = await analyze(f, { message: input.last_assistant_message ?? undefined })
  const alreadyBlocked = new Set(gates.flatMap((g) => g.blocked))
  const timesBlocked = gates.filter((g) => g.blocked.length).length
  const fresh = findings.filter((x) => x.level === 'block' && !alreadyBlocked.has(x.id))
  const loopsLeft = agent === 'cursor' ? (input.loop_count ?? 0) < f.config.maxBlocks : timesBlocked < f.config.maxBlocks

  if (f.config.mode === 'enforce' && fresh.length && loopsLeft) {
    append(root, { t: 'gate', at: Date.now(), session, tree: f.tree, blocked: fresh.map((x) => x.id) })
    const reason = blockReason(fresh)
    if (agent === 'cursor') return { followup_message: reason }
    return { decision: 'block', reason }
  }

  append(root, { t: 'gate', at: Date.now(), session, tree: f.tree, blocked: [] })
  // Claude Code shows systemMessage to the person only; other agents get nothing extra
  if (agent === 'claude') return { systemMessage: userSummary(f, findings, review) }
  return agent === 'cursor' ? {} : null
}
