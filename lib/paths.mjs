// @ts-check

export const TEST_FILE =
  /(^|\/)(tests?|__tests__|specs?|e2e|cypress|playwright)\/|\.(test|spec|e2e|cy)\.[cm]?[jt]sx?$|_test\.(go|py|rb|exs?)$|(^|\/)test_[^/]*\.py$|(^|\/)conftest\.py$|Tests?\.(cs|java|kt|swift)$|_spec\.rb$/i

export const CODE_FILE =
  /\.(c|cc|cpp|cs|dart|ex|exs|go|h|hpp|java|jsx?|kt|kts|m|mjs|cjs|mts|cts|php|py|rb|rs|scala|svelte|swift|tsx?|vue|astro|sql|sh|bash|zsh|ps1|lua|zig)$/i

export const DOC_FILE = /\.(md|mdx|markdown|txt|rst|adoc)$|(^|\/)(LICENSE|CHANGELOG|AUTHORS|NOTICE)[^/]*$|(^|\/)docs?\//i

export const LOCK_FILE =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|Pipfile\.lock|uv\.lock|composer\.lock|Gemfile\.lock|mix\.lock|pubspec\.lock|flake\.lock)$/

export const GENERATED_FILE =
  /(^|\/)(dist|build|out|coverage|\.next|\.nuxt|\.svelte-kit|target|vendor|__generated__|generated)\/|\.min\.(js|css)$|\.map$|\.snap$|_pb2(_grpc)?\.py$|\.pb\.go$|\.g\.dart$/i

/** @param {string} path */
export const isTest = (path) => TEST_FILE.test(path)
/** @param {string} path */
export const isDoc = (path) => DOC_FILE.test(path) && !isTest(path)
/** @param {string} path */
export const isCode = (path) => CODE_FILE.test(path) && !isTest(path) && !GENERATED_FILE.test(path)
/** @param {string} path */
export const isNoise = (path) => LOCK_FILE.test(path) || GENERATED_FILE.test(path)
