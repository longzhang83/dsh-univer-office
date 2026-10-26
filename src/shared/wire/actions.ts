import type { FileState } from './state.ts'

/** Worktree lifecycle actions exposed by the browser UI. */
export type WorktreeReviewAction = 'ready' | 'reopen' | 'discard' | 'merge'

/** Kinds of report-only semantic checks attached to merge results. */
export type MergeSemanticCheckKind = 'structure' | 'layout' | 'formula' | 'cross-unit-reference'

/** Outcome of one report-only merge semantic check. */
export type MergeSemanticCheckStatus = 'pass' | 'warn' | 'unavailable' | 'error'

/** JSON-serializable payload attached to one semantic check entry. */
export type MergeSemanticCheckDetails =
  | null
  | boolean
  | number
  | string
  | readonly MergeSemanticCheckDetails[]
  | { readonly [key: string]: MergeSemanticCheckDetails }

/**
 * One report-only semantic check over the Units a merge touched. OT success
 * does not prove business semantics, so merge results may carry these entries
 * for human review; they never change the merge outcome. `unavailable` marks a
 * check whose required capability does not exist inside this repository
 * boundary; `error` marks a check that could not run (for example it timed out).
 */
export interface MergeSemanticCheck {
  readonly kind: MergeSemanticCheckKind
  readonly status: MergeSemanticCheckStatus
  readonly summary: string
  /** Unit the entry refers to; omitted for file-level entries. */
  readonly unitId?: string
  readonly details?: MergeSemanticCheckDetails
}

/** Result of one worktree review decision. */
export type WorktreeActionResult =
  | {
      readonly ok: true
      readonly action: WorktreeReviewAction
      readonly worktreeId: string
      readonly state: FileState
      /** Present only for merge actions; report-only and optional for compatibility. */
      readonly semanticChecks?: readonly MergeSemanticCheck[]
    }
  | { readonly ok: false; readonly reason: string; readonly state?: FileState }
