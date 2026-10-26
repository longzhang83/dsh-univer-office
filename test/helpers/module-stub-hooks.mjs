/**
 * ESM loader hooks that let `node --experimental-strip-types` load the Host
 * TypeScript sources in a checkout without `node_modules`: every bare
 * (external) import resolves to a generated stub module, and a few in-repo
 * modules can be redirected to test seams.
 *
 * The point is to run the *real* implementation of the modules under test.
 * Nothing inside them is patched: only their unavailable package dependencies
 * and the bundled child-process entry are replaced.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const STUB_SCHEME = 'stub:'

/** Real error base: `UniverError extends HarnessError`, and tests assert on `code`. */
const DSH_LLM_STUB = `export class HarnessError extends Error {
  constructor(message, code, options) {
    super(typeof message === 'string' ? message : undefined, options)
    this.name = 'HarnessError'
    this.code = typeof code === 'string' ? code : ''
  }
}
export default HarnessError
`

/**
 * A stub value is both callable and constructible, and carries `message` and
 * `code` so `UniverError`-shaped throw sites keep working through the stubs.
 */
const STUB_FACTORY = `const __stub = (name) => {
  const impl = function (...args) {
    this.name = name
    this.message = typeof args[0] === 'string' ? args[0] : ''
    this.code = typeof args[1] === 'string' ? args[1] : ''
  }
  Object.defineProperty(impl, 'name', { value: name, configurable: true })
  return impl
}
`

let overrides = []
const namesByPackage = new Map()

/** Receive the configuration handed to `register()`. */
export function initialize(data) {
  overrides = (data?.overrides ?? []).map(([suffix, target]) => [suffix, target])
  collectImportNames(data?.sourceRoot)
}

/** Map every external package to the union of the names any source imports from it. */
function collectImportNames(sourceRoot) {
  if (typeof sourceRoot !== 'string') return
  const imports = /import\s+(?:type\s+)?([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/gu
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue
      const source = readFileSync(path, 'utf8')
      for (const [, clause, specifier] of source.matchAll(imports)) {
        for (const name of importNames(clause)) {
          if (!namesByPackage.has(specifier)) namesByPackage.set(specifier, new Set())
          namesByPackage.get(specifier).add(name)
        }
      }
    }
  }
  walk(sourceRoot)
}

/** Named (not aliased, not namespace) bindings of one import clause. */
function importNames(clause) {
  const trimmed = clause.trim()
  if (trimmed.startsWith('{') === false) return []
  return trimmed
    .slice(1, trimmed.lastIndexOf('}'))
    .split(',')
    .map((part) => part.trim().replace(/^type\s+/u, ''))
    .filter((part) => part.length > 0)
    .map((part) => part.split(/\s+as\s+/u)[0].trim())
    .filter((part) => /^[A-Za-z_$][\w$]*$/u.test(part))
}

function isExternal(specifier) {
  return (
    specifier.startsWith('.') === false &&
    specifier.startsWith('/') === false &&
    specifier.startsWith('node:') === false &&
    specifier.startsWith('file:') === false &&
    specifier.startsWith('data:') === false &&
    /^[a-z@]/u.test(specifier)
  )
}

export async function resolve(specifier, context, next) {
  for (const [suffix, target] of overrides) {
    if (specifier.endsWith(suffix)) return { url: target, format: 'module', shortCircuit: true }
  }
  if (isExternal(specifier))
    return {
      url: `${STUB_SCHEME}${encodeURIComponent(specifier)}`,
      format: 'module',
      shortCircuit: true
    }
  return next(specifier, context)
}

export async function load(url, context, next) {
  if (url.startsWith(STUB_SCHEME)) {
    const specifier = decodeURIComponent(url.slice(STUB_SCHEME.length))
    return { format: 'module', source: stubSource(specifier), shortCircuit: true }
  }
  return next(url, context)
}

function stubSource(specifier) {
  if (specifier === '@deepseek-ai/dsh-llm') return DSH_LLM_STUB
  const names = [...(namesByPackage.get(specifier) ?? [])]
  const exports = names.map((name) => `export const ${name} = __stub(${JSON.stringify(name)})`)
  exports.push('export default __stub("default")')
  return `${STUB_FACTORY}${exports.join('\n')}\n`
}
