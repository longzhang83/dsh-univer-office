import type { ISheetBlock, ISnapshot } from '@univerjs/protocol'
import type { UniverfileSQLiteDatabaseAdapter } from './univerfile-sqlite/index.js'

/**
 * When a materialization becomes worth persisting.
 *
 * Checkpoints trade one extra snapshot write for a shorter replay on every later load of the same
 * Unit, so both numbers stay deliberately coarse: a short replay is cheaper than the write, and a
 * long retention grows the `.univer` file without shortening the replay further.
 */
export interface SnapshotCheckpointPolicy {
  /** Replayed changesets that justify persisting the materialized snapshot. */
  readonly minReplayedChangesets: number
  /** Checkpoint rows kept per Unit, newest first, in addition to the revision-1 baseline. */
  readonly retainedCheckpoints: number
}

export const DEFAULT_SNAPSHOT_CHECKPOINT_POLICY: SnapshotCheckpointPolicy = {
  minReplayedChangesets: 32,
  retainedCheckpoints: 4
}

export interface SnapshotCheckpointInput {
  readonly unitId: string
  /** Materialized snapshot produced by replaying `replayedChangesets` onto a persisted snapshot. */
  readonly snapshot: ISnapshot
  readonly sheetBlocks?: readonly ISheetBlock[]
  readonly replayedChangesets: number
}

/**
 * Turns expensive materializations into checkpoints.
 *
 * The trigger is threshold-based rather than timer-based on purpose: a checkpoint is only written
 * when a read actually paid for a long replay, so a file that is never reopened is never enlarged
 * and no timer has to outlive the request.
 */
export class SnapshotCheckpointer {
  public constructor(
    private readonly _adapter: Pick<UniverfileSQLiteDatabaseAdapter, 'saveCheckpoint'>,
    private readonly _policy: SnapshotCheckpointPolicy = DEFAULT_SNAPSHOT_CHECKPOINT_POLICY
  ) {}

  /** Best effort: returns whether a checkpoint was stored, and never fails the caller. */
  public async record(input: SnapshotCheckpointInput): Promise<boolean> {
    if (input.replayedChangesets < this._policy.minReplayedChangesets) {
      return false
    }
    try {
      return this._adapter.saveCheckpoint({
        snapshot: input.snapshot,
        ...(input.sheetBlocks === undefined ? {} : { sheetBlocks: input.sheetBlocks }),
        retainedCheckpoints: this._policy.retainedCheckpoints
      })
    } catch {
      // Expected failures: SQLITE_BUSY under a concurrent writer, or a `.univer` opened read-only.
      // A checkpoint is derived acceleration, so losing one must not fail the read that produced it.
      return false
    }
  }
}
