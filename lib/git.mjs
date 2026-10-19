// @ts-check
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Run git and return stdout, or null if it fails.
 * @param {string} cwd
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 */
export function git(cwd, args, env) {
  try {
    return execFileSync('git', args, {
      cwd,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
      timeout: 8000,
    })
  } catch {
    return null
  }
}

/** @param {string} cwd */
export function repoRoot(cwd) {
  return git(cwd, ['rev-parse', '--show-toplevel'])?.trim() || null
}

/**
 * Take a snapshot of the whole working tree (tracked changes and new files,
 * respecting .gitignore) and return its tree hash.
 * Uses a temporary index, so the user's staging area is never touched.
 * @param {string} root
 */
export function snapshot(root) {
  const dir = mkdtempSync(join(tmpdir(), 'receipts-'))
  const index = join(dir, 'index')
  try {
    const env = { GIT_INDEX_FILE: index }
    // copy the real index so git can reuse its file cache and only re-read changed files
    const realIndex = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])?.trim()
    if (realIndex && existsSync(realIndex)) {
      copyFileSync(realIndex, index)
      // keep the original timestamp: git uses it to spot files changed in the same
      // second the index was written ("racy" files) and re-reads them
      const { atime, mtime } = statSync(realIndex)
      utimesSync(index, atime, mtime)
    }
    if (git(root, ['add', '-A', '--', '.'], env) === null) return null
    return git(root, ['write-tree'], env)?.trim() || null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * @typedef {{ path: string, status: string, added: number, removed: number, oldPath?: string }} ChangedFile
 */

/**
 * Files changed between two tree hashes.
 * @param {string} root
 * @param {string} from
 * @param {string} to
 * @returns {ChangedFile[]}
 */
export function changedFiles(root, from, to) {
  const numstat = git(root, ['diff', '--numstat', '-z', '-M', from, to]) ?? ''
  const status = git(root, ['diff', '--name-status', '-z', '-M', from, to]) ?? ''

  /** @type {Map<string, ChangedFile>} */
  const files = new Map()

  const s = status.split('\0')
  for (let i = 0; i < s.length - 1; ) {
    const code = s[i++]
    if (!code) continue
    if (code.startsWith('R') || code.startsWith('C')) {
      const oldPath = s[i++]
      const path = s[i++]
      files.set(path, { path, oldPath, status: code[0], added: 0, removed: 0 })
    } else {
      const path = s[i++]
      files.set(path, { path, status: code[0], added: 0, removed: 0 })
    }
  }

  // numstat with -z: "added\tremoved\tpath\0" or "added\tremoved\t\0old\0new\0" for renames
  const n = numstat.split('\0')
  for (let i = 0; i < n.length - 1; ) {
    const head = n[i++]
    if (!head) continue
    const [a, r, p] = head.split('\t')
    let path = p
    if (!p) {
      i++ // old path
      path = n[i++]
    }
    const file = files.get(path)
    if (file) {
      // binary files show "-"
      file.added = a === '-' ? 0 : Number(a)
      file.removed = r === '-' ? 0 : Number(r)
    }
  }

  return [...files.values()]
}

/**
 * Added lines and changed line ranges per file, from a zero-context diff.
 * @param {string} root
 * @param {string} from
 * @param {string} to
 */
export function diffHunks(root, from, to) {
  const out = git(root, ['diff', '-U0', '--no-color', '-M', from, to]) ?? ''
  /** @type {{ file: string, start: number, count: number, added: { line: number, text: string }[] }[]} */
  const hunks = []
  let file = ''
  /** @type {(typeof hunks)[number] | null} */
  let hunk = null
  let line = 0
  for (const raw of out.split('\n')) {
    if (raw.startsWith('+++ ')) {
      file = raw.slice(4).replace(/^b\//, '')
      if (file === '/dev/null') file = ''
      continue
    }
    if (raw.startsWith('--- ')) continue
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(raw)
    if (m) {
      line = Number(m[1])
      hunk = { file, start: line, count: m[2] === undefined ? 1 : Number(m[2]), added: [] }
      if (file) hunks.push(hunk)
      continue
    }
    if (hunk && raw.startsWith('+')) {
      hunk.added.push({ line, text: raw.slice(1) })
      line++
    }
  }
  return hunks
}

/**
 * Read a file as it was in a tree, or null if it didn't exist.
 * @param {string} root
 * @param {string} tree
 * @param {string} path
 */
export function showFile(root, tree, path) {
  return git(root, ['show', `${tree}:${path}`])
}
