import type {
  MergePreview,
  MergeSemanticCheck,
  MergeUnitPreview,
  MergePreviewBlockPage,
  MergePreviewUnitBlockManifest,
  WorktreeStatus
} from './contract/index.js'
import type { IChangeset, IDeserializedSheetBlock, ISnapshot } from '@univerjs/protocol'

/**
 * Types kept by the gateway compatibility facade. They describe CLI control requests and
 * responses only; the SDK owns the collaboration and persistence contracts underneath.
 */
export interface CreateUnitInput {
  readonly unitId?: string
  readonly name?: string
  readonly data?: object
}

export interface CreateUnitResult {
  readonly unitId: string
  readonly sheetOrder?: string[]
}

export interface ApplyResult {
  success: boolean
  currentRevision: number
  isConflictError?: boolean
  isCsDeduplicate?: boolean
  error?: Error
}

export interface WorktreeCreatedUnit {
  unitId: string
  type: number
  name: string
}

export interface WorktreeRecord {
  worktreeId: string
  status: WorktreeStatus
  agentId: string
  name: string
  baseline: Record<string, number>
  createdAt: string
  mergedAt?: string
}

export type MergeOutcome =
  | {
      ok: true
      mergedRevs: Record<string, number>
      broadcasts: Array<{ unitId: string; changeset: IChangeset }>
      addedUnits: WorktreeCreatedUnit[]
      updatedUnits: Array<{ unitId: string; name: string; headRev: number }>
      removedUnits: string[]
    }
  | { ok: false; conflict: true; failedUnit: string }

export interface MergePreviewUnitData {
  type: number
  snapshot?: ISnapshot
  sheetBlocks?: IDeserializedSheetBlock[]
  /** Block inventory of `snapshot`; lets consumers page blocks instead of taking them inline. */
  blockManifest?: MergePreviewUnitBlockManifest
  error?: string
}

export interface MergePreviewUnitBlocksData {
  type: number
  blocks?: IDeserializedSheetBlock[]
  page?: MergePreviewBlockPage
  error?: string
}

export type { MergePreview, MergeSemanticCheck, MergeUnitPreview }
