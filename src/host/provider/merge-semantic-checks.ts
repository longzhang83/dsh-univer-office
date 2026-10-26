import type { MergeSemanticCheck } from '../../shared/wire/actions.ts'
import { GatewayClient } from '../adapters/gateway/client.ts'
import {
  isRecord,
  mapUnits,
  unitKind,
  type GatewayUnit
} from '../adapters/gateway/mapping.ts'
import { GatewayWorktreeApi } from '../adapters/gateway/worktree-api.ts'
import type { InspectUnitContentRequest, JsonValue, WorkspacePath } from '../service/types.ts'
import { UniverError } from '../service/errors.ts'
import { unitId, worktreeId } from '../service/identifiers.ts'
import { UnitContentOperations } from './unit-content-operations.ts'
import { RenderOperations } from './render-operations.ts'

/** File and scope shared by every check in one phase. */
interface MergeCheckScope {
  readonly gateway: string
  readonly workspace: WorkspacePath
  readonly file: string
  readonly worktreeId?: string
}

/**
 * Report-only semantic checks over the Units one worktree contributed to a
 * merge. OT success only proves that operations transform; it does not prove
 * that the merged content is still coherent, so these checks attach structured
 * warnings to merge results for human review. They run strictly after the
 * Gateway accepted the merge, never throw, and never change the merge outcome.
 *
 * Only two checks are real inside this repository boundary: structural
 * inspection through the bundled content worker and Slide layout lint through
 * the render machine. Formula evaluation after a merge is not reachable here
 * (the Viewer computes formulas when the merged snapshot loads), so Sheet
 * entries are reported as `unavailable` instead of being silently skipped.
 */
export class MergeSemanticChecks {
  constructor(
    private readonly unitContent: UnitContentOperations,
    private readonly render: RenderOperations
  ) {}

  /**
   * Check every listed Unit in trunk (`worktreeId` omitted, post-merge) or in
   * one worktree. The whole phase shares one deadline: when it fires, pending
   * checks resolve to `error` entries and in-flight content workers are
   * aborted, so the phase always settles within `timeoutMs` plus exit overhead.
   */
  async run(input: MergeCheckScope & {
    readonly units: readonly GatewayUnit[]
    readonly timeoutMs: number
  }): Promise<readonly MergeSemanticCheck[]> {
    if (input.units.length === 0) return []
    const controller = new AbortController()
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        controller.abort()
        resolve('timeout')
      }, input.timeoutMs)
    })
    try {
      const perUnit = await Promise.all(
        input.units.map((unit) =>
          this.checkUnit(input, unit, input.timeoutMs, deadline, controller.signal)
        )
      )
      return perUnit.flat()
    } catch {
      // checkUnit never rejects; this guards the merge path against any
      // future regression so checks can never fail the merge itself.
      return []
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private async checkUnit(
    input: MergeCheckScope,
    unit: GatewayUnit,
    timeoutMs: number,
    deadline: Promise<'timeout'>,
    signal: AbortSignal
  ): Promise<readonly MergeSemanticCheck[]> {
    const kind = unitKind(unit.type)
    const checks = [
      await raceDeadline(
        this.structureCheck(input, unit, kind, signal),
        deadline,
        'structure',
        unit.unitId,
        timeoutMs
      )
    ]
    if (kind === 'slide') {
      checks.push(
        await raceDeadline(
          this.layoutCheck(input, unit, signal),
          deadline,
          'layout',
          unit.unitId,
          timeoutMs
        )
      )
    }
    if (kind === 'sheet') {
      checks.push(formulaUnavailable(unit.unitId))
    }
    return checks
  }

  /** Inspect the merged snapshot through the same read path as `univer_inspect`. */
  private async structureCheck(
    input: MergeCheckScope,
    unit: GatewayUnit,
    kind: string | null,
    signal: AbortSignal
  ): Promise<MergeSemanticCheck> {
    try {
      const request: InspectUnitContentRequest = {
        workspace: input.workspace,
        file: input.file,
        unitId: unitId(unit.unitId),
        ...(input.worktreeId === undefined ? {} : { worktreeId: worktreeId(input.worktreeId) })
      }
      await this.unitContent.inspect(input.gateway, request, signal)
      return {
        kind: 'structure',
        status: 'pass',
        unitId: unit.unitId,
        summary: `Merged ${kind ?? 'Unit'} snapshot passed structural inspection.`
      }
    } catch (error) {
      return checkFailure('structure', unit.unitId, 'Structural inspection failed', error)
    }
  }

  /** Lint the merged Slide snapshot through the same path as `univer_lint`. */
  private async layoutCheck(
    input: MergeCheckScope,
    unit: GatewayUnit,
    signal: AbortSignal
  ): Promise<MergeSemanticCheck> {
    try {
      const source = await this.unitContent.renderSource(
        input.gateway,
        input.file,
        unit.unitId,
        input.worktreeId,
        signal
      )
      const report = await this.render.lint(source, undefined, signal)
      const findings = countLintFindings(report)
      if (findings === null) {
        return {
          kind: 'layout',
          status: 'unavailable',
          unitId: unit.unitId,
          summary:
            'Slide layout lint completed, but its report could not be interpreted in this boundary; the raw report is attached.',
          // JsonValue and the wire details type are structurally the same JSON.
          details: report as MergeSemanticCheck['details']
        }
      }
      if (findings === 0) {
        return {
          kind: 'layout',
          status: 'pass',
          unitId: unit.unitId,
          summary: 'Slide layout lint found no off-page, escaping, or overlapping text.'
        }
      }
      return {
        kind: 'layout',
        status: 'warn',
        unitId: unit.unitId,
        summary: `Slide layout lint reported ${String(findings)} layout finding(s) in the merged Unit.`,
        // JsonValue and the wire details type are structurally the same JSON.
        details: report as MergeSemanticCheck['details']
      }
    } catch (error) {
      return checkFailure('layout', unit.unitId, 'Slide layout lint failed', error)
    }
  }
}

/** Formula semantics after a merge require evaluation this boundary does not own. */
function formulaUnavailable(unitId: string): MergeSemanticCheck {
  return {
    kind: 'formula',
    status: 'unavailable',
    unitId,
    summary:
      'Formula evaluation is not available in the merge path; the Viewer computes formulas when the merged snapshot loads.'
  }
}

/**
 * Classify one check failure. Worker transport problems are check
 * infrastructure (`error`); everything else means the merged content could not
 * be read or linted and is a review warning (`warn`).
 */
function checkFailure(
  kind: MergeSemanticCheck['kind'],
  unitId: string,
  action: string,
  error: unknown
): MergeSemanticCheck {
  const message = error instanceof Error ? error.message : String(error)
  const infrastructure =
    error instanceof UniverError && error.code.startsWith('UNIT_CONTENT_WORKER_')
  return {
    kind,
    status: infrastructure ? 'error' : 'warn',
    unitId,
    summary: `${action} for the merged Unit: ${message}`,
    details: { error: message }
  }
}

/**
 * Count findings in a layout lint report without coupling to the
 * `@univer-cli/unit-layout-lint` internals; `null` means the shape was not
 * recognized and the raw report must speak for itself.
 */
function countLintFindings(report: JsonValue): number | null {
  if (Array.isArray(report)) return report.length
  if (!isRecord(report)) return null
  for (const key of ['findings', 'issues', 'violations', 'lints', 'problems']) {
    const value = report[key]
    if (Array.isArray(value)) return value.length
  }
  return null
}

/** Resolve to a timeout entry when the shared phase deadline fires first. */
async function raceDeadline(
  work: Promise<MergeSemanticCheck>,
  deadline: Promise<'timeout'>,
  kind: MergeSemanticCheck['kind'],
  unitId: string,
  timeoutMs: number
): Promise<MergeSemanticCheck> {
  return Promise.race([
    work,
    deadline.then((): MergeSemanticCheck => ({
      kind,
      status: 'error',
      unitId,
      summary: `Semantic check timed out after ${String(timeoutMs)}ms and was aborted; it did not affect the merge.`
    }))
  ])
}

/** List the live Units of one worktree, the scope a merge will publish. */
export async function listMergedUnits(
  gateway: string,
  file: string,
  worktreeId: string,
  requestTimeoutMs: number
): Promise<readonly GatewayUnit[]> {
  return mapUnits(
    await new GatewayWorktreeApi(new GatewayClient(gateway, requestTimeoutMs)).listUnits(
      file,
      worktreeId
    )
  )
}
