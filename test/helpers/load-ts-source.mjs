/**
 * Register the stub loader before a test imports Host TypeScript sources.
 *
 * Importing this module has the side effect of installing the hooks, so a test
 * file only needs `import '../helpers/load-ts-source.mjs'` before its first
 * `await import('<source>.ts')`.
 */
import { register } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

register(new URL('./module-stub-hooks.mjs', import.meta.url).href, import.meta.url, {
  data: {
    sourceRoot: join(repoRoot, 'src'),
    overrides: [
      ['artifacts/paths.ts', new URL('./artifact-paths-seam.mjs', import.meta.url).href]
    ]
  }
})

/** Absolute path of one Host source file, for dynamic import. */
export function sourcePath(relative) {
  return join(repoRoot, 'src', relative)
}
