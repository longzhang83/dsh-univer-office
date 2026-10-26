/**
 * Behaviour tests for `src/host/provider/merge-semantic-checks.ts`.
 *
 * Run: node --experimental-transform-types --test test/merge-semantic-checks-smoke.mjs
 *
 * `UnitContentOperations` and `RenderOperations` are replaced by fakes: they
 * are the boundaries (content worker + render machine) that need a built
 * bundle. Everything inside `MergeSemanticChecks` — deadline handling, failure
 * classification, scoping — is the real implementation.
 */
import './helpers/load-ts-source.mjs'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const { MergeSemanticChecks, listMergedUnits } = await import(
  '../src/host/provider/merge-semantic-checks.ts'
)
const { UniverError } = await import('../src/host/service/errors.ts')

const GATEWAY = 'http://127.0.0.1:8199'
const WORKSPACE = '/workspace'
const FILE = '/workspace/demo.univer'

const unit = (unitId, type) => ({ unitId, name: unitId, type, headRev: 3 })

/** Fake read path: records every call and delegates the outcome to `handlers`. */
function fakeContent(handlers = {}) {
  const calls = { inspect: [], renderSource: [] }
  return {
    calls,
    async inspect(gateway, request, signal) {
      calls.inspect.push({ gateway, request, signal })
      return handlers.inspect === undefined ? {} : handlers.inspect(request, signal)
    },
    async renderSource(gateway, file, unitId, worktreeId, signal) {
      calls.renderSource.push({ gateway, file, unitId, worktreeId, signal })
      return handlers.renderSource === undefined
        ? { unitType: 'slide', unitData: {} }
        : handlers.renderSource()
    }
  }
}

/** Fake lint path: `report` is what the render machine would have returned. */
function fakeRender(report) {
  const calls = []
  return {
    calls,
    async lint(source, options, signal) {
      calls.push({ source, options, signal })
      if (typeof report === 'function') return report()
      return report
    }
  }
}

const scope = (units, overrides = {}) => ({
  gateway: GATEWAY,
  workspace: WORKSPACE,
  file: FILE,
  units,
  timeoutMs: 500,
  ...overrides
})

describe('MergeSemanticChecks structure check', () => {
  it('passes when the merged snapshot inspects cleanly', async () => {
    const content = fakeContent()
    const checks = await new MergeSemanticChecks(content, fakeRender({})).run(
      scope([unit('doc-1', 1)])
    )

    assert.deepEqual(
      checks.map((check) => [check.kind, check.status, check.unitId]),
      [['structure', 'pass', 'doc-1']]
    )
    assert.match(checks[0].summary, /doc/u)
  })

  it('reports a review warning when inspection fails', async () => {
    const content = fakeContent({
      inspect: async () => {
        throw new Error('merged snapshot is unreadable')
      }
    })
    const checks = await new MergeSemanticChecks(content, fakeRender({})).run(
      scope([unit('doc-1', 1)])
    )

    assert.equal(checks.length, 1)
    assert.equal(checks[0].status, 'warn')
    assert.equal(
      checks[0].summary,
      'Structural inspection failed for the merged Unit: merged snapshot is unreadable'
    )
    assert.deepEqual(checks[0].details, { error: 'merged snapshot is unreadable' })
  })

  it('classifies worker transport failures as check infrastructure', async () => {
    const content = fakeContent({
      inspect: async () => {
        throw new UniverError('worker died', 'UNIT_CONTENT_WORKER_INVALID_RESPONSE')
      }
    })
    const checks = await new MergeSemanticChecks(content, fakeRender({})).run(
      scope([unit('doc-1', 1)])
    )

    assert.equal(checks[0].status, 'error')
    assert.match(checks[0].summary, /worker died/u)
  })

  it('survives a synchronous throw and a non-Error rejection', async () => {
    const thrown = new MergeSemanticChecks(
      fakeContent({
        inspect: () => {
          throw new Error('thrown before any promise')
        }
      }),
      fakeRender({})
    )
    const rejected = new MergeSemanticChecks(
      fakeContent({ inspect: async () => Promise.reject('plain string failure') }),
      fakeRender({})
    )

    const thrownChecks = await thrown.run(scope([unit('doc-1', 1)]))
    const rejectedChecks = await rejected.run(scope([unit('doc-1', 1)]))

    assert.equal(thrownChecks[0].status, 'warn')
    assert.match(thrownChecks[0].summary, /thrown before any promise/u)
    assert.equal(rejectedChecks[0].status, 'warn')
    assert.match(rejectedChecks[0].summary, /plain string failure/u)
  })

  it('settles on a timeout entry and aborts the in-flight read', async () => {
    let seenSignal
    const content = fakeContent({
      inspect: async (_request, signal) => {
        seenSignal = signal
        return await new Promise(() => {
          // hangs on purpose; only the abort can end it
        })
      }
    })
    const started = Date.now()
    const checks = await new MergeSemanticChecks(content, fakeRender({})).run(
      scope([unit('doc-1', 1)], { timeoutMs: 40 })
    )
    const elapsed = Date.now() - started

    assert.equal(checks.length, 1)
    assert.equal(checks[0].status, 'error')
    assert.equal(
      checks[0].summary,
      'Semantic check timed out after 40ms and was aborted; it did not affect the merge.'
    )
    assert.equal(seenSignal.aborted, true, 'the aborted read path must be cancelled')
    assert.ok(elapsed < 400, `check phase should settle near the deadline, took ${String(elapsed)}ms`)
  })
})

describe('MergeSemanticChecks Slide layout check', () => {
  const slide = [unit('slide-1', 3)]

  it('passes when the lint report is empty', async () => {
    const render = fakeRender({ findings: [] })
    const checks = await new MergeSemanticChecks(fakeContent(), render).run(scope(slide))

    assert.deepEqual(
      checks.map((check) => [check.kind, check.status]),
      [
        ['structure', 'pass'],
        ['layout', 'pass']
      ]
    )
    assert.equal(render.calls[0].options, undefined)
    assert.deepEqual(render.calls[0].source, { unitType: 'slide', unitData: {} })
  })

  it('warns with the raw report when findings exist', async () => {
    const report = { findings: [{ rule: 'off-page' }] }
    const checks = await new MergeSemanticChecks(fakeContent(), fakeRender(report)).run(scope(slide))
    const layout = checks.find((check) => check.kind === 'layout')

    assert.equal(layout.status, 'warn')
    assert.match(layout.summary, /1 layout finding\(s\)/u)
    assert.deepEqual(layout.details, report)
  })

  it('counts findings from a bare array report', async () => {
    const checks = await new MergeSemanticChecks(fakeContent(), fakeRender([{ a: 1 }, { b: 2 }])).run(
      scope(slide)
    )
    const layout = checks.find((check) => check.kind === 'layout')
    assert.equal(layout.status, 'warn')
    assert.match(layout.summary, /2 layout finding\(s\)/u)
  })

  it('marks an uninterpretable report unavailable instead of passing it', async () => {
    const report = { summary: 'unknown report shape' }
    const checks = await new MergeSemanticChecks(fakeContent(), fakeRender(report)).run(scope(slide))
    const layout = checks.find((check) => check.kind === 'layout')

    assert.equal(layout.status, 'unavailable')
    assert.deepEqual(layout.details, report)
  })

  it('warns when linting fails, keeping the structural result', async () => {
    const checks = await new MergeSemanticChecks(
      fakeContent(),
      fakeRender(() => {
        throw new Error('lint machine unavailable')
      })
    ).run(scope(slide))

    assert.deepEqual(
      checks.map((check) => [check.kind, check.status]),
      [
        ['structure', 'pass'],
        ['layout', 'warn']
      ]
    )
    assert.match(checks[1].summary, /lint machine unavailable/u)
  })
})

describe('MergeSemanticChecks availability and scope', () => {
  it('reports formula checks as unavailable for Sheet Units', async () => {
    const checks = await new MergeSemanticChecks(fakeContent(), fakeRender({})).run(
      scope([unit('sheet-1', 2)])
    )

    assert.deepEqual(
      checks.map((check) => [check.kind, check.status]),
      [
        ['structure', 'pass'],
        ['formula', 'unavailable']
      ]
    )
    assert.match(checks[1].summary, /Viewer computes formulas/u)
  })

  it('checks only the Units in scope, with the merge file and worktree', async () => {
    const content = fakeContent()
    const checks = await new MergeSemanticChecks(content, fakeRender({})).run(
      scope([unit('doc-1', 1), unit('sheet-2', 2)], { worktreeId: 'wt-7' })
    )

    assert.equal(content.calls.inspect.length, 2)
    assert.deepEqual(
      content.calls.inspect.map((call) => call.request.unitId),
      ['doc-1', 'sheet-2']
    )
    for (const call of content.calls.inspect) {
      assert.equal(call.gateway, GATEWAY)
      assert.equal(call.request.file, FILE)
      assert.equal(call.request.workspace, WORKSPACE)
      assert.equal(call.request.worktreeId, 'wt-7')
    }
    assert.deepEqual(
      checks.map((check) => check.unitId),
      ['doc-1', 'sheet-2', 'sheet-2']
    )
    assert.equal(
      content.calls.inspect.some((call) => call.request.unitId === 'some-other-unit'),
      false
    )
  })

  it('omits the worktree when checking trunk after a merge', async () => {
    const content = fakeContent()
    await new MergeSemanticChecks(content, fakeRender({})).run(scope([unit('doc-1', 1)]))

    assert.equal('worktreeId' in content.calls.inspect[0].request, false)
  })

  it('does nothing for an empty Unit list', async () => {
    const content = fakeContent()
    const render = fakeRender({})
    const checks = await new MergeSemanticChecks(content, render).run(scope([]))

    assert.deepEqual(checks, [])
    assert.equal(content.calls.inspect.length, 0)
    assert.equal(render.calls.length, 0)
  })

  it('keeps reporting an entry per Unit when every check fails', async () => {
    const checks = await new MergeSemanticChecks(
      fakeContent({
        inspect: async () => {
          throw new Error('unreadable')
        },
        renderSource: async () => {
          throw new Error('no source')
        }
      }),
      fakeRender(() => {
        throw new Error('no lint')
      })
    ).run(scope([unit('doc-1', 1), unit('slide-2', 3)]))

    assert.deepEqual(
      checks.map((check) => [check.unitId, check.kind, check.status]),
      [
        ['doc-1', 'structure', 'warn'],
        ['slide-2', 'structure', 'warn'],
        ['slide-2', 'layout', 'warn']
      ]
    )
  })
})

describe('listMergedUnits', () => {
  it('maps the Units of one worktree through the Gateway', async () => {
    const original = globalThis.fetch
    const seen = []
    globalThis.fetch = async (url, init) => {
      seen.push({ url, init })
      return {
        ok: true,
        status: 200,
        json: async () => ({
          units: [
            { unitId: 'doc-1', name: 'Doc', type: 1, headRev: 4 },
            { unitId: 'sheet-2', name: 'Sheet', type: 2 },
            { name: 'nameless', type: 2 },
            'not an object'
          ]
        })
      }
    }
    try {
      const units = await listMergedUnits(GATEWAY, FILE, 'wt-7', 1_000)

      assert.equal(seen.length, 1)
      assert.ok(seen[0].url.startsWith(`${GATEWAY}/uf/`), seen[0].url)
      assert.ok(seen[0].url.endsWith('/worktrees/wt-7/units'), seen[0].url)
      assert.equal(seen[0].init.method, 'GET')
      assert.deepEqual(units, [
        { unitId: 'doc-1', name: 'Doc', type: 1, headRev: 4 },
        { unitId: 'sheet-2', name: 'Sheet', type: 2, headRev: 0 }
      ])
    } finally {
      globalThis.fetch = original
    }
  })
})
