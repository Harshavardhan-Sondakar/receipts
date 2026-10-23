// @ts-check
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * @typedef {'enforce' | 'warn' | 'off'} Mode
 * @typedef {{
 *   mode: Mode,
 *   maxBlocks: number,
 *   require: string[],
 *   commands: Record<string, string>,
 *   ignore: string[],
 *   sensitive: string[],
 *   registry: boolean,
 * }} Config
 */

/** @type {Config} */
export const DEFAULTS = {
  // enforce: send the agent back to fix blocking problems; warn: only tell you; off: no gate
  mode: 'enforce',
  // how many times per task the agent can be sent back, so it can never loop forever
  maxBlocks: 2,
  // which kinds of check must run on the final code, if the project has them
  require: ['test', 'typecheck', 'lint'],
  // your own commands, e.g. { "test": "make test" }, used when there's no package.json script
  commands: {},
  // finding ids or categories to skip, e.g. ["debug-print", "deps"]
  ignore: [],
  // extra paths that count as sensitive, e.g. ["src/billing/"]
  sensitive: [],
  // look up new dependencies on npm / PyPI
  registry: true,
}

/**
 * Settings from receipts.json or the "receipts" key in package.json,
 * plus RECEIPTS_MODE from the environment.
 * @param {string} root
 * @returns {Config}
 */
export function loadConfig(root) {
  /** @type {Partial<Config>} */
  let user = {}
  try {
    const file = join(root, 'receipts.json')
    if (existsSync(file)) user = JSON.parse(readFileSync(file, 'utf8'))
    else {
      const pkg = join(root, 'package.json')
      if (existsSync(pkg)) user = JSON.parse(readFileSync(pkg, 'utf8')).receipts ?? {}
    }
  } catch {
    // a broken config shouldn't break the agent, fall back to defaults
  }
  /** @type {Config} */
  const config = { ...DEFAULTS, ...user, commands: { ...DEFAULTS.commands, ...user.commands } }
  const envMode = process.env.RECEIPTS_MODE
  if (envMode === 'enforce' || envMode === 'warn' || envMode === 'off') config.mode = envMode
  if (!['enforce', 'warn', 'off'].includes(config.mode)) config.mode = 'enforce'
  return config
}
