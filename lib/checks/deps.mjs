// @ts-check
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { showFile } from '../git.mjs'

/**
 * @typedef {import('../facts.mjs').Facts} Facts
 * @typedef {import('../findings.mjs').Finding} Finding
 * @typedef {{ ecosystem: 'npm' | 'pypi' | 'go', name: string, file: string, spec?: string }} NewDep
 * @typedef {{ exists: boolean, created?: string, downloads?: number }} PackageInfo
 * @typedef {(ecosystem: 'npm' | 'pypi', name: string) => Promise<PackageInfo | null>} Lookup
 */

// well known packages; a new dependency one letter away from these is suspicious
const POPULAR_NPM = `react react-dom vue svelte angular next nuxt express koa fastify hono lodash underscore axios
  node-fetch got request moment dayjs date-fns luxon chalk commander yargs inquirer ora debug dotenv uuid nanoid
  zod yup joi ajv typescript ts-node tsx esbuild vite webpack rollup parcel babel-core @babel/core eslint prettier
  jest vitest mocha chai sinon cypress playwright puppeteer jsdom cheerio mongoose mongodb mysql mysql2 pg sqlite3
  redis ioredis prisma sequelize typeorm knex drizzle-orm graphql apollo-server socket.io ws cors helmet morgan
  body-parser cookie-parser multer bcrypt bcryptjs jsonwebtoken passport sharp jimp classnames clsx tailwindcss
  postcss autoprefixer sass less styled-components emotion rxjs immer redux zustand mobx jquery bootstrap
  three d3 chart.js marked markdown-it highlight.js glob minimatch rimraf mkdirp fs-extra cross-env concurrently
  nodemon pm2 semver yaml js-yaml xml2js csv-parse papaparse openai @anthropic-ai/sdk langchain stripe aws-sdk
  firebase supabase @supabase/supabase-js colors qs ramda bluebird async rxjs validator nodemailer winston pino
  bunyan cross-spawn execa shelljs tslib core-js regenerator-runtime web-vitals electron react-router
  react-router-dom @tanstack/react-query swr formik react-hook-form framer-motion`
  .split(/\s+/)
  .filter(Boolean)

const POPULAR_PYPI = `requests numpy pandas django flask fastapi pydantic sqlalchemy pytest boto3 botocore urllib3 setuptools
  wheel pip six python-dateutil pyyaml jinja2 click rich typer httpx aiohttp uvicorn gunicorn celery redis
  psycopg2 psycopg2-binary pymongo matplotlib scipy scikit-learn tensorflow torch transformers openai anthropic
  langchain beautifulsoup4 lxml pillow cryptography pyjwt bcrypt passlib python-dotenv tqdm colorama selenium
  playwright black ruff mypy flake8 isort pylint poetry attrs marshmallow alembic tornado starlette websockets
  grpcio protobuf google-cloud-storage azure-storage-blob paramiko fabric docker kubernetes openpyxl xlrd
  networkx sympy seaborn plotly dash streamlit gradio`
  .split(/\s+/)
  .filter(Boolean)

/**
 * New dependencies between the start of the task and now.
 * @param {Facts} f
 * @returns {NewDep[]}
 */
export function newDependencies(f) {
  if (!f.baseTree || !f.tree) return []
  /** @type {NewDep[]} */
  const out = []
  for (const file of f.files) {
    if (file.status === 'D') continue
    const name = file.path.split('/').pop() ?? ''
    const before = file.status === 'A' ? null : showFile(f.root, f.baseTree, file.oldPath ?? file.path)
    const after = showFile(f.root, f.tree, file.path)
    if (name === 'package.json') {
      const old = npmDeps(before)
      for (const [dep, spec] of npmDeps(after)) if (!old.has(dep)) out.push({ ecosystem: 'npm', name: dep, spec, file: file.path })
    } else if (/^requirements[\w.-]*\.(txt|in)$/.test(name)) {
      const old = new Set(pyDeps(before))
      for (const dep of pyDeps(after)) if (!old.has(dep)) out.push({ ecosystem: 'pypi', name: dep, file: file.path })
    } else if (name === 'pyproject.toml') {
      const old = new Set(pyprojectDeps(before))
      for (const dep of pyprojectDeps(after)) if (!old.has(dep)) out.push({ ecosystem: 'pypi', name: dep, file: file.path })
    } else if (name === 'go.mod') {
      const re = /^\s*(?:require\s+)?([\w.-]+\.[\w./-]+)\s+v[\d.]/gm
      const old = new Set([...(before ?? '').matchAll(re)].map((m) => m[1]))
      for (const m of (after ?? '').matchAll(re)) if (!old.has(m[1])) out.push({ ecosystem: 'go', name: m[1], file: file.path })
    }
  }
  const seen = new Set()
  return out.filter((d) => !seen.has(d.ecosystem + d.name) && seen.add(d.ecosystem + d.name))
}

/** @param {string | null} text */
function npmDeps(text) {
  /** @type {Map<string, string>} */
  const deps = new Map()
  try {
    const pkg = JSON.parse(text ?? '{}')
    for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const [name, spec] of Object.entries(pkg[k] ?? {})) deps.set(name, String(spec))
    }
  } catch {}
  return deps
}

/** @param {string | null} text */
function pyDeps(text) {
  return (text ?? '')
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim())
    .filter((l) => l && !l.startsWith('-') && !l.includes('://'))
    .map((l) => normalizePy(l.split(/[\s=<>!~;[@]/)[0]))
    .filter(Boolean)
}

/** @param {string | null} text */
function pyprojectDeps(text) {
  const t = text ?? ''
  /** @type {string[]} */
  const names = []
  // PEP 621: dependencies = ["requests>=2", ...]
  for (const block of t.matchAll(/^\s*(?:dependencies|[\w-]+)\s*=\s*\[([^\]]*)\]/gm)) {
    for (const m of block[1].matchAll(/["']([A-Za-z0-9][\w.-]*)/g)) names.push(normalizePy(m[1]))
  }
  // poetry: [tool.poetry.dependencies] name = "^1"
  const poetry = /\[tool\.poetry\.(?:dev-)?dependencies\]([\s\S]*?)(?:\n\[|$)/.exec(t)
  if (poetry) for (const m of poetry[1].matchAll(/^\s*([A-Za-z0-9][\w.-]*)\s*=/gm)) if (m[1] !== 'python') names.push(normalizePy(m[1]))
  return names
}

/** @param {string} name */
function normalizePy(name) {
  return name.toLowerCase().replace(/[_.]+/g, '-')
}

/**
 * Edit distance, capped: we only care about "one or two letters off".
 * @param {string} a
 * @param {string} b
 */
function distance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      // swapped letters count as one
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
    }
  }
  return d[a.length][b.length]
}

/**
 * @param {string} name
 * @param {'npm' | 'pypi'} ecosystem
 */
function lookalike(name, ecosystem) {
  const list = ecosystem === 'npm' ? POPULAR_NPM : POPULAR_PYPI
  if (list.includes(name)) return null
  const bare = name.replace(/^@[^/]+\//, '')
  for (const p of list) {
    const limit = p.length >= 8 ? 2 : 1
    if (distance(bare, p) <= limit || distance(name, p) <= limit) return p
    // "react-dom-v2", "lodashs": popular name plus a little extra
    const extras = [`${p}s`, `${p}js`, `${p}-js`, `node-${p}`, `${p}-node`]
    if (extras.includes(bare) && !list.includes(bare)) return p
  }
  return null
}

/**
 * Turn new dependencies into findings, looking each one up when we can.
 * @param {Facts} f
 * @param {Lookup | null} lookup null when offline or switched off
 * @returns {Promise<Finding[]>}
 */
export async function checkDependencies(f, lookup) {
  const deps = newDependencies(f)
  if (!deps.length) return []
  /** @type {Finding[]} */
  const out = []
  const now = Date.now()
  const privateRegistry = hasPrivateRegistry(f.root)

  // one line for all new dependencies; problems with a specific one get their own line
  const names = deps.map((d) => `\`${d.name}\``)
  out.push({
    id: `deps:new:${deps.map((d) => d.name).join(',')}`,
    cat: 'deps',
    level: 'warn',
    text: `${deps.length} new dependenc${deps.length === 1 ? 'y' : 'ies'}`,
    where: names.length > 6 ? `${names.slice(0, 6).join(', ')} (+${names.length - 6} more)` : names.join(', '),
  })

  // local, git or aliased packages aren't on the public registry under this name
  const checkable = deps
    .slice(0, 12)
    .filter((d) => d.ecosystem !== 'go' && lookup)
    .filter((d) => !(d.spec && /^(workspace:|file:|link:|portal:|git|https?:|github:|npm:)/.test(d.spec)))
    .filter((d) => !(d.ecosystem === 'npm' && privateRegistry && d.name.startsWith('@')))
  // all lookups at once, so ten new packages don't take ten times as long
  const infos = await Promise.all(
    checkable.map((d) => (lookup ? lookup(/** @type {'npm' | 'pypi'} */ (d.ecosystem), d.name).catch(() => null) : null)),
  )

  for (const [i, dep] of checkable.entries()) {
    const label = `\`${dep.name}\` (${dep.file})`
    const info = infos[i]
    if (!info) continue
    const registry = dep.ecosystem === 'npm' ? 'npm' : 'PyPI'
    if (!info.exists) {
      if (privateRegistry) continue
      out.push({
        id: `deps:missing:${dep.name}`,
        cat: 'deps',
        level: 'block',
        text: `Package doesn't exist on ${registry}. AI tools sometimes invent package names, and attackers register them`,
        where: label,
        fix: `Check the real package name for what you need and fix ${dep.file}.`,
      })
      continue
    }
    const ageDays = info.created ? (now - Date.parse(info.created)) / 86_400_000 : null
    const fewDownloads = info.downloads !== undefined && info.downloads < 100
    const young = ageDays !== null && ageDays < 30
    const near = lookalike(dep.name, /** @type {'npm' | 'pypi'} */ (dep.ecosystem))
    if (near && (fewDownloads || (ageDays !== null && ageDays < 180))) {
      out.push({
        id: `deps:typo:${dep.name}`,
        cat: 'deps',
        level: 'block',
        text: `Name is very close to the popular \`${near}\` but this package is ${young ? 'brand new' : 'barely used'} (possible typo or typosquat)`,
        where: label,
        fix: `Make sure you meant \`${dep.name}\` and not \`${near}\`.`,
      })
      continue
    }
    if (young) {
      out.push({ id: `deps:young:${dep.name}`, cat: 'deps', level: 'warn', text: `Package was first published ${Math.max(0, Math.round(ageDays ?? 0))} days ago`, where: label })
    }
    if (fewDownloads) {
      out.push({ id: `deps:unused:${dep.name}`, cat: 'deps', level: 'warn', text: `Package has only ${info.downloads} downloads last week`, where: label })
    }
  }
  return out
}

/** @param {string} root */
function hasPrivateRegistry(root) {
  try {
    const npmrc = join(root, '.npmrc')
    return existsSync(npmrc) && /registry\s*=/.test(readFileSync(npmrc, 'utf8'))
  } catch {
    return false
  }
}

/**
 * Look packages up on npm / PyPI with a short timeout and a week-long cache,
 * so it's quick and works offline (it just finds nothing).
 * @param {string} root
 * @returns {Lookup}
 */
export function registryLookup(root) {
  const cacheFile = join(root, '.receipts', 'registry-cache.json')
  /** @type {Record<string, PackageInfo & { at: number }>} */
  let cache = {}
  try {
    cache = JSON.parse(readFileSync(cacheFile, 'utf8'))
  } catch {}

  /**
   * @param {string} url
   * @returns {Promise<any>}
   */
  const get = async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000), headers: { accept: 'application/json' } })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
  }

  return async (ecosystem, name) => {
    const key = `${ecosystem}:${name}`
    const hit = cache[key]
    if (hit && Date.now() - hit.at < 7 * 86_400_000) return hit
    /** @type {PackageInfo} */
    let info
    if (ecosystem === 'npm') {
      const meta = await get(`https://registry.npmjs.org/${name.replace('/', '%2f')}`)
      if (!meta) info = { exists: false }
      else {
        info = { exists: true, created: meta.time?.created }
        const dl = await get(`https://api.npmjs.org/downloads/point/last-week/${name}`).catch(() => null)
        if (dl && typeof dl.downloads === 'number') info.downloads = dl.downloads
      }
    } else {
      const meta = await get(`https://pypi.org/pypi/${name}/json`)
      if (!meta) info = { exists: false }
      else {
        const uploads = Object.values(meta.releases ?? {})
          .flat()
          .map((/** @type {any} */ r) => r.upload_time_iso_8601)
          .filter(Boolean)
          .sort()
        info = { exists: true, created: uploads[0] }
      }
    }
    cache[key] = { ...info, at: Date.now() }
    try {
      writeFileSync(cacheFile, JSON.stringify(cache))
    } catch {}
    return info
  }
}
