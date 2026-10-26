/**
 * Behaviour tests for `src/host/provider/render-cache.ts`.
 *
 * Run: node --experimental-transform-types --test test/render-cache-smoke.mjs
 *
 * The cache is exercised against a real temporary directory: entries are
 * written and read back through the filesystem, so eviction, TTL expiry, and
 * payload faults are observed, not simulated.
 */
import './helpers/load-ts-source.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, describe, it } from 'node:test'

const { RenderArtifactCache, assertCachedImageName, renderCacheKey } = await import(
  '../src/host/provider/render-cache.ts'
)

const FILE = '/workspace/demo.univer'
const BASE = {
  kind: 'screenshot',
  file: FILE,
  unitId: 'unit-1',
  revisions: [['unit-1', 7]]
}

const screenshotEntry = (bytes = 'png-bytes') => ({
  kind: 'screenshot',
  images: [
    {
      name: 'sheet.png',
      width: 640,
      height: 480,
      metadata: { sheet: 'Sheet1' },
      bytes: Buffer.from(bytes)
    }
  ]
})

const pdfEntry = () => ({
  kind: 'pdf',
  bytes: Buffer.from('%PDF-1.7 fake'),
  pageCount: 3,
  unitId: 'unit-1',
  unitType: 'sheet'
})

let roots = []

async function tempRoot() {
  const dir = await mkdtemp(join(tmpdir(), 'univer-render-cache-'))
  roots.push(dir)
  return dir
}

after(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('renderCacheKey', () => {
  it('changes when the head revision of the rendered Unit moves', () => {
    const before = renderCacheKey(BASE)
    const after = renderCacheKey({ ...BASE, revisions: [['unit-1', 8]] })
    assert.notEqual(before, after)
  })

  it('changes when a render dependency revision moves', () => {
    const before = renderCacheKey({ ...BASE, revisions: [['unit-1', 7], ['unit-2', 3]] })
    const after = renderCacheKey({ ...BASE, revisions: [['unit-1', 7], ['unit-2', 4]] })
    assert.notEqual(before, after)
  })

  it('separates screenshot ranges, page caps, and pixel caps', () => {
    const plain = renderCacheKey(BASE)
    assert.notEqual(
      plain,
      renderCacheKey({ ...BASE, target: { kind: 'sheet-range', range: 'A1:B2' } })
    )
    assert.notEqual(plain, renderCacheKey({ ...BASE, maxPages: 2 }))
    assert.notEqual(plain, renderCacheKey({ ...BASE, maxPixels: 1_000 }))
    assert.notEqual(renderCacheKey({ ...BASE, maxPages: 2 }), renderCacheKey({ ...BASE, maxPages: 3 }))
  })

  it('separates worktree scope, artifact kind, file, and Unit', () => {
    assert.notEqual(renderCacheKey(BASE), renderCacheKey({ ...BASE, worktreeId: 'wt-1' }))
    assert.notEqual(renderCacheKey(BASE), renderCacheKey({ ...BASE, kind: 'pdf' }))
    assert.notEqual(renderCacheKey(BASE), renderCacheKey({ ...BASE, file: '/workspace/other.univer' }))
    assert.notEqual(renderCacheKey(BASE), renderCacheKey({ ...BASE, unitId: 'unit-2' }))
  })

  it('is stable regardless of object key order', () => {
    const forward = renderCacheKey({
      kind: 'screenshot',
      file: FILE,
      unitId: 'unit-1',
      revisions: [['unit-1', 7]],
      maxPages: 2
    })
    const backward = renderCacheKey({
      maxPages: 2,
      revisions: [['unit-1', 7]],
      unitId: 'unit-1',
      file: FILE,
      kind: 'screenshot'
    })
    assert.equal(forward, backward)
    assert.match(forward, /^[0-9a-f]{64}$/u)
  })
})

describe('RenderArtifactCache', () => {
  let root
  beforeEach(async () => {
    root = await tempRoot()
  })

  it('serves the second identical render from the cache', async () => {
    const cache = new RenderArtifactCache(root, 8, 60_000)
    let produced = 0
    const produce = async () => {
      produced += 1
      return screenshotEntry(`png-${String(produced)}`)
    }

    const first = await cache.getOrProduce(renderCacheKey(BASE), produce)
    const second = await cache.getOrProduce(renderCacheKey(BASE), produce)

    assert.equal(first.hit, false)
    assert.equal(second.hit, true)
    assert.equal(produced, 1)
    assert.deepEqual(second.entry, first.entry)
    assert.equal(second.entry.images[0].bytes.toString('utf8'), 'png-1')
    // The payload really came back off disk, not out of memory.
    assert.deepEqual(second.entry.images[0].bytes, Buffer.from('png-1'))
    assert.equal(second.entry.images[0].metadata.sheet, 'Sheet1')
  })

  it('round-trips PDF payloads with their page count and Unit identity', async () => {
    const cache = new RenderArtifactCache(root, 8, 60_000)
    const entry = pdfEntry()
    const stored = await cache.getOrProduce(renderCacheKey({ ...BASE, kind: 'pdf' }), async () => entry)
    const loaded = await cache.getOrProduce(renderCacheKey({ ...BASE, kind: 'pdf' }), async () => {
      throw new Error('produce must not run on a hit')
    })
    assert.equal(loaded.hit, true)
    assert.deepEqual(loaded.entry, entry)
  })

  it('never serves a render produced before the revision moved', async () => {
    const cache = new RenderArtifactCache(root, 8, 60_000)
    let produced = 0
    const produce = async () => screenshotEntry(`png-${String(++produced)}`)

    await cache.getOrProduce(renderCacheKey(BASE), produce)
    const staleKey = renderCacheKey(BASE)
    const moved = await cache.getOrProduce(
      renderCacheKey({ ...BASE, revisions: [['unit-1', 8]] }),
      produce
    )

    assert.equal(moved.hit, false)
    assert.equal(produced, 2)
    assert.equal(moved.entry.images[0].bytes.toString('utf8'), 'png-2')
    // The superseded entry is still cached under its own (now unreachable) key.
    const stale = await cache.getOrProduce(staleKey, async () => {
      throw new Error('produce must not run on a hit')
    })
    assert.equal(stale.hit, true)
    assert.equal(stale.entry.images[0].bytes.toString('utf8'), 'png-1')
  })

  it('evicts the least recently used entry once the cap is reached', async () => {
    const cache = new RenderArtifactCache(root, 2, 60_000)
    const keys = [1, 2, 3].map((revision) =>
      renderCacheKey({ ...BASE, revisions: [['unit-1', revision]] })
    )
    let produced = 0
    const produce = async () => screenshotEntry(`png-${String(++produced)}`)

    for (const key of keys) await cache.getOrProduce(key, produce)
    const onDisk = await readdir(root)
    assert.equal(onDisk.length, 2)
    assert.equal(onDisk.includes(keys[0]), false)

    const revived = await cache.getOrProduce(keys[0], produce)
    assert.equal(revived.hit, false)
    assert.equal(produced, 4)
    assert.equal(revived.entry.images[0].bytes.toString('utf8'), 'png-4')
  })

  it('expires entries past the TTL instead of returning them', async () => {
    const cache = new RenderArtifactCache(root, 8, 40)
    const key = renderCacheKey(BASE)
    let produced = 0
    const produce = async () => screenshotEntry(`png-${String(++produced)}`)

    await cache.getOrProduce(key, produce)
    await new Promise((resolve) => setTimeout(resolve, 80))
    const expired = await cache.getOrProduce(key, produce)

    assert.equal(expired.hit, false)
    assert.equal(produced, 2)
    assert.equal(expired.entry.images[0].bytes.toString('utf8'), 'png-2')
    assert.equal((await readdir(root)).includes(key), true)
  })

  it('coalesces concurrent callers of one key into a single render', async () => {
    const cache = new RenderArtifactCache(root, 8, 60_000)
    const key = renderCacheKey(BASE)
    let produced = 0
    const produce = async () => {
      produced += 1
      await new Promise((resolve) => setTimeout(resolve, 30))
      return screenshotEntry('png-shared')
    }

    const [leader, follower] = await Promise.all([
      cache.getOrProduce(key, produce),
      cache.getOrProduce(key, produce)
    ])

    assert.equal(produced, 1)
    assert.equal(leader.hit, false)
    assert.equal(follower.hit, true)
    assert.deepEqual(follower.entry, leader.entry)
  })

  it('does not cache a failed render, and retries it on the next call', async () => {
    const cache = new RenderArtifactCache(root, 8, 60_000)
    const key = renderCacheKey(BASE)
    let attempted = 0

    await assert.rejects(
      cache.getOrProduce(key, async () => {
        attempted += 1
        throw new Error(`render failed ${String(attempted)}`)
      }),
      /render failed 1/u
    )

    const retried = await cache.getOrProduce(key, async () => {
      attempted += 1
      return screenshotEntry('png-after-failure')
    })
    assert.equal(attempted, 2)
    assert.equal(retried.hit, false)
    assert.equal(retried.entry.images[0].bytes.toString('utf8'), 'png-after-failure')
  })

  it('retries in the follower when the leader it joined failed', async () => {
    const cache = new RenderArtifactCache(root, 8, 60_000)
    const key = renderCacheKey(BASE)
    let attempted = 0
    const produce = async () => {
      attempted += 1
      if (attempted === 1) throw new Error('first render failed')
      await new Promise((resolve) => setTimeout(resolve, 20))
      return screenshotEntry('png-retry')
    }

    const [leader, follower] = await Promise.all([
      cache.getOrProduce(key, produce).then(
        (outcome) => outcome,
        (error) => error
      ),
      cache.getOrProduce(key, produce)
    ])

    assert.match(String(leader.message), /first render failed/u)
    assert.equal(follower.hit, false)
    assert.equal(attempted, 2)
    assert.equal(follower.entry.images[0].bytes.toString('utf8'), 'png-retry')
  })

  it('degrades to a fresh render when a cached payload cannot be read', async () => {
    const cache = new RenderArtifactCache(root, 8, 60_000)
    const key = renderCacheKey(BASE)
    let produced = 0
    const produce = async () => screenshotEntry(`png-${String(++produced)}`)

    await cache.getOrProduce(key, produce)
    await rm(join(root, key, 'image-0000.png'))

    const repaired = await cache.getOrProduce(key, produce)
    assert.equal(repaired.hit, false)
    assert.equal(produced, 2)
    assert.equal(repaired.entry.images[0].bytes.toString('utf8'), 'png-2')
  })

  it('degrades to a fresh render when a cached payload is corrupt', async () => {
    const cache = new RenderArtifactCache(root, 8, 60_000)
    const key = renderCacheKey(BASE)
    let produced = 0
    const produce = async () => screenshotEntry(`png-${String(++produced)}`)

    await cache.getOrProduce(key, produce)
    await writeFile(join(root, key, 'meta.json'), '{ not json')

    const repaired = await cache.getOrProduce(key, produce)
    assert.equal(repaired.hit, false)
    assert.equal(produced, 2)
  })

  it('returns the rendered artifact even when it cannot be written to disk', async () => {
    // A regular file as the cache root makes every `mkdir` fail, which is the
    // same fault class as a full or read-only cache directory.
    const blocked = join(root, 'not-a-directory')
    await writeFile(blocked, 'occupied')
    const cache = new RenderArtifactCache(join(blocked, 'cache'), 8, 60_000)
    const key = renderCacheKey(BASE)
    let produced = 0
    const produce = async () => screenshotEntry(`png-${String(++produced)}`)

    const first = await cache.getOrProduce(key, produce)
    const second = await cache.getOrProduce(key, produce)

    assert.equal(first.hit, false)
    assert.deepEqual(first.entry, screenshotEntry('png-1'))
    assert.equal(second.hit, false, 'an unwritable cache must not be reported as a hit')
    assert.equal(produced, 2)
  })

  it('drops every entry on clear', async () => {
    const cache = new RenderArtifactCache(root, 8, 60_000)
    const key = renderCacheKey(BASE)
    await cache.getOrProduce(key, async () => screenshotEntry('png-1'))
    await cache.clear()

    assert.deepEqual(await readdir(root), [])
    const after = await cache.getOrProduce(key, async () => screenshotEntry('png-2'))
    assert.equal(after.hit, false)
    assert.equal(after.entry.images[0].bytes.toString('utf8'), 'png-2')
  })

  it('keeps the payload of the last writer readable on disk', async () => {
    const cache = new RenderArtifactCache(root, 8, 60_000)
    const key = renderCacheKey({ ...BASE, kind: 'pdf' })
    await cache.getOrProduce(key, async () => pdfEntry())
    const bytes = await readFile(join(root, key, 'output.pdf'), 'utf8')
    assert.equal(bytes, '%PDF-1.7 fake')
  })
})

describe('assertCachedImageName', () => {
  it('accepts a plain file name', () => {
    assert.doesNotThrow(() => assertCachedImageName('sheet-1.png'))
  })

  it('rejects a name that escapes the output directory', () => {
    assert.throws(
      () => assertCachedImageName('../../etc/passwd'),
      (error) => error.code === 'SCREENSHOT_OUTPUT_INVALID'
    )
  })
})
