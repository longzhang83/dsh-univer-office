import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { UniverError } from '../service/errors.ts'
import type { JsonValue, ScreenshotTarget, UniverUnitKind } from '../service/types.ts'

/** Cacheable render artifact kinds; the key kind always matches the entry kind. */
export type RenderCacheEntry =
  | {
      readonly kind: 'screenshot'
      readonly images: readonly {
        readonly name: string
        readonly width: number
        readonly height: number
        readonly metadata: JsonValue
        readonly bytes: Buffer
      }[]
    }
  | {
      readonly kind: 'pdf'
      readonly bytes: Buffer
      readonly pageCount: number
      readonly unitId: string
      readonly unitType: Exclude<UniverUnitKind, 'base'>
    }

/** Result of one `getOrProduce` call; `hit` reports whether a cached artifact was reused. */
export interface RenderCacheOutcome {
  readonly entry: RenderCacheEntry
  readonly hit: boolean
}

interface RenderCacheRecord {
  readonly at: number
  readonly dir: string
}

/** In-flight outcome: exactly one of `entry` and `error` is set. */
type ProduceOutcome =
  | { readonly entry: RenderCacheEntry; readonly error?: undefined }
  | { readonly entry?: undefined; readonly error: unknown }

/**
 * JSON payload that decides one render-cache key. Every input that can change
 * the rendered artifact belongs here: file identity, Unit scope, the head
 * revisions of the primary Unit and all render dependencies, the artifact
 * kind, and every output-affecting parameter.
 */
export interface RenderCacheKeyInput {
  readonly kind: 'screenshot' | 'pdf'
  readonly file: string
  readonly unitId: string
  readonly worktreeId?: string
  /** `(unitId, headRevision)` pairs; empty or missing revisions must disable caching. */
  readonly revisions: readonly (readonly [string, number])[]
  readonly target?: ScreenshotTarget
  readonly maxPages?: number
  readonly maxPixels?: number
}

/** Disk layout mirrored by `RenderCacheMeta`; payload bytes live next to it. */
type RenderCacheMeta =
  | {
      readonly kind: 'screenshot'
      readonly images: readonly {
        readonly name: string
        readonly width: number
        readonly height: number
        readonly metadata: JsonValue
        readonly file: string
      }[]
    }
  | {
      readonly kind: 'pdf'
      readonly pageCount: number
      readonly unitId: string
      readonly unitType: Exclude<UniverUnitKind, 'base'>
      readonly file: string
    }

const KEY_VERSION = 1
const PDF_PAYLOAD = 'output.pdf'

/**
 * Deterministic cache key for one render artifact. Object keys are sorted and
 * revision pairs are expected pre-sorted, so equal inputs always hash equal.
 */
export function renderCacheKey(input: RenderCacheKeyInput): string {
  const payload: JsonValue = {
    v: KEY_VERSION,
    kind: input.kind,
    file: input.file,
    unitId: input.unitId,
    ...(input.worktreeId === undefined ? {} : { worktreeId: input.worktreeId }),
    revisions: input.revisions.map(([unitId, headRev]) => [unitId, headRev] as JsonValue),
    ...(input.target === undefined ? {} : { target: input.target as unknown as JsonValue }),
    ...(input.maxPages === undefined ? {} : { maxPages: input.maxPages }),
    ...(input.maxPixels === undefined ? {} : { maxPixels: input.maxPixels })
  }
  return createHash('sha256').update(stableStringify(payload)).digest('hex')
}

/** Bounded, LRU-evicted, TTL-expired artifact cache owned by the Provider. */
export class RenderArtifactCache {
  private readonly records = new Map<string, RenderCacheRecord>()
  private readonly inflight = new Map<string, Promise<ProduceOutcome>>()

  constructor(
    private readonly root: string,
    private readonly maxEntries: number,
    private readonly ttlMs: number
  ) {}

  /**
   * Return a cached artifact or render, store, and return a fresh one.
   * Concurrent callers sharing a key coalesce onto one render; a failed peer
   * render is retried by the remaining caller instead of failing with it.
   * Cache faults (read, write, eviction) degrade to a miss and never fail the
   * render itself; production errors propagate unchanged.
   */
  async getOrProduce(
    key: string,
    produce: () => Promise<RenderCacheEntry>
  ): Promise<RenderCacheOutcome> {
    const cached = await this.load(key)
    if (cached !== undefined) return { entry: cached, hit: true }
    const pending = this.inflight.get(key)
    if (pending !== undefined) {
      const peer = await pending
      if (peer.entry !== undefined) return { entry: peer.entry, hit: true }
      const retry = await this.runAndStore(key, produce)
      if (retry.entry === undefined) throw retry.error
      return { entry: retry.entry, hit: false }
    }
    const outcome = await this.run(key, produce)
    if (outcome.entry === undefined) throw outcome.error
    return { entry: outcome.entry, hit: false }
  }

  /** Remove tracked entries during disposal; leftover directories expire via prune. */
  async clear(): Promise<void> {
    const records = [...this.records.values()]
    this.records.clear()
    await Promise.all(
      records.map((record) =>
        // Disposal cleanup is best-effort; undeletable directories expire via prune.
        rm(record.dir, { recursive: true, force: true }).catch(() => {})
      )
    )
  }

  private async run(
    key: string,
    produce: () => Promise<RenderCacheEntry>
  ): Promise<ProduceOutcome> {
    const pending = this.runAndStore(key, produce)
    this.inflight.set(key, pending)
    try {
      return await pending
    } finally {
      if (this.inflight.get(key) === pending) this.inflight.delete(key)
    }
  }

  /** Failures are returned, not thrown, so a peer failure can be retried by its caller. */
  private async runAndStore(
    key: string,
    produce: () => Promise<RenderCacheEntry>
  ): Promise<ProduceOutcome> {
    try {
      const entry = await produce()
      await this.store(key, entry)
      return { entry }
    } catch (error) {
      return { error }
    }
  }

  /** Read the payload back; any fault becomes a cache miss. */
  private async load(key: string): Promise<RenderCacheEntry | undefined> {
    const record = this.records.get(key)
    if (record === undefined) return undefined
    if (Date.now() - record.at > this.ttlMs) {
      this.records.delete(key)
      await rm(record.dir, { recursive: true, force: true }).catch(() => {
        // The expired directory is swept again by the next prune.
      })
      return undefined
    }
    try {
      const entry = await this.readEntry(record.dir)
      this.records.delete(key)
      this.records.set(key, record)
      return entry
    } catch {
      // Missing or corrupt payload: drop the record and rerender normally.
      this.records.delete(key)
      return undefined
    }
  }

  private async readEntry(dir: string): Promise<RenderCacheEntry> {
    const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as RenderCacheMeta
    if (meta.kind === 'screenshot') {
      const images = await Promise.all(
        meta.images.map(async (image) => ({
          name: image.name,
          width: image.width,
          height: image.height,
          metadata: image.metadata,
          bytes: await readFile(resolve(dir, image.file))
        }))
      )
      return { kind: 'screenshot', images }
    }
    return {
      kind: 'pdf',
      bytes: await readFile(resolve(dir, meta.file)),
      pageCount: meta.pageCount,
      unitId: meta.unitId,
      unitType: meta.unitType
    }
  }

  /** Storage faults are swallowed: the render already succeeded in the workspace. */
  private async store(key: string, entry: RenderCacheEntry): Promise<void> {
    const dir = join(this.root, key)
    const meta: RenderCacheMeta =
      entry.kind === 'screenshot'
        ? {
            kind: 'screenshot',
            images: entry.images.map((image, index) => ({
              name: image.name,
              width: image.width,
              height: image.height,
              metadata: image.metadata,
              file: `image-${String(index).padStart(4, '0')}.png`
            }))
          }
        : {
            kind: 'pdf',
            pageCount: entry.pageCount,
            unitId: entry.unitId,
            unitType: entry.unitType,
            file: PDF_PAYLOAD
          }
    try {
      await mkdir(dir, { recursive: true })
      if (entry.kind === 'screenshot') {
        await Promise.all(
          entry.images.map((image, index) =>
            writeFile(resolve(dir, metaImageFile(index)), image.bytes)
          )
        )
      } else {
        await writeFile(resolve(dir, PDF_PAYLOAD), entry.bytes)
      }
      await writeFile(join(dir, 'meta.json'), JSON.stringify(meta))
      this.records.delete(key)
      this.records.set(key, { at: Date.now(), dir })
    } catch {
      await rm(dir, { recursive: true, force: true }).catch(() => {
        // A partially written entry is untracked and expires via prune.
      })
      this.records.delete(key)
      return
    }
    await this.prune()
  }

  /**
   * Enforce the entry cap (LRU by insertion order) and sweep directories left
   * by earlier processes, whose in-memory index is gone: untracked directories
   * expire once older than the TTL, keeping the disk bounded.
   */
  private async prune(): Promise<void> {
    while (this.records.size > this.maxEntries) {
      const oldest = this.records.keys().next()
      if (oldest.done === true) break
      const record = this.records.get(oldest.value)
      this.records.delete(oldest.value)
      if (record === undefined) continue
      // Eviction is best-effort; an undeletable directory expires via the TTL sweep.
      await rm(record.dir, { recursive: true, force: true }).catch(() => {})
    }
    let listing: string[]
    try {
      listing = await readdir(this.root)
    } catch {
      return
    }
    for (const name of listing) {
      const dir = join(this.root, name)
      if (name.startsWith('.') || !name.match(/^[0-9a-f]{64}$/u)) continue
      if ([...this.records.values()].some((record) => record.dir === dir)) continue
      try {
        const info = await stat(dir)
        if (!info.isDirectory()) continue
        if (Date.now() - info.mtimeMs > this.ttlMs) {
          await rm(dir, { recursive: true, force: true })
        }
      } catch {
        // The directory vanished or cannot be inspected; nothing to sweep.
      }
    }
  }
}

function metaImageFile(index: number): string {
  return `image-${String(index).padStart(4, '0')}.png`
}

/** Sort keys recursively so JSON.stringify order cannot leak into the hash. */
function stableStringify(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key]!)}`)
  return `{${entries.join(',')}}`
}

/** Guard reused by the Service: a cached PNG must never escape its output directory. */
export function assertCachedImageName(name: string): void {
  if (basename(name) !== name) {
    throw new UniverError(`Unsafe screenshot image name: ${name}`, 'SCREENSHOT_OUTPUT_INVALID')
  }
}
