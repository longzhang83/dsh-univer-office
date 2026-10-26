import Database from 'libsql'

export const DEFAULT_UNIVERFILE_SQLITE_BUSY_TIMEOUT_MS = 5_000

/**
 * `wal` enables write-ahead logging so concurrent readers never wait for the writer lock;
 * `default` leaves the journal mode stored in the database file untouched. Migration and
 * optimization flows pass `default`: they replace files by rename and must not add sidecar
 * files or mutate the source database on disk.
 */
export type UniverfileSQLiteJournalMode = 'default' | 'wal'

export const DEFAULT_UNIVERFILE_SQLITE_JOURNAL_MODE: UniverfileSQLiteJournalMode = 'wal'

export const DEFAULT_UNIVERFILE_SQLITE_PAYLOAD_COMPRESSION = true

let savepointSequence = 0

export interface UniverfileSQLiteConnectionOptions {
  /** SQLite filename or `:memory:`. The parent directory must already exist. */
  readonly filename: string
  /** How long SQLite waits for another writer before reporting SQLITE_BUSY. */
  readonly busyTimeoutMs?: number
  /** Defaults to `wal` for runtime connections; migration and optimization pass `default`. */
  readonly journalMode?: UniverfileSQLiteJournalMode
  /** Whether newly written changeset/snapshot payloads are gzip-compressed at rest. */
  readonly payloadCompression?: boolean
}

/**
 * Owns one physical SQLite connection shared by the trunk and Worktree adapters, plus an optional
 * read-only reader used by pure read paths.
 *
 * Adapters borrowed from this owner never close the database independently. This mirrors the
 * original CLI gateway, where the trunk and Worktree stores shared one libsql connection.
 */
export class UniverfileSQLiteConnection {
  public readonly database: Database.Database
  public readonly filename: string
  public readonly journalMode: UniverfileSQLiteJournalMode
  public readonly payloadCompressionEnabled: boolean

  private readonly _busyTimeoutMs: number
  private _readDatabase: Database.Database | undefined
  private _readDatabaseFailed = false
  private _disposed = false

  public constructor(options: UniverfileSQLiteConnectionOptions) {
    validateOptions(options)
    this.filename = options.filename
    this._busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_UNIVERFILE_SQLITE_BUSY_TIMEOUT_MS
    this.journalMode = options.journalMode ?? DEFAULT_UNIVERFILE_SQLITE_JOURNAL_MODE
    this.payloadCompressionEnabled =
      options.payloadCompression ?? DEFAULT_UNIVERFILE_SQLITE_PAYLOAD_COMPRESSION
    this.database = new Database(options.filename, { timeout: this._busyTimeoutMs })

    try {
      this.database.exec('PRAGMA foreign_keys = ON;')
      this.database.exec(`PRAGMA busy_timeout = ${this._busyTimeoutMs};`)
    } catch (error) {
      this.database.close()
      this._disposed = true
      throw error
    }

    if (this.journalMode === 'wal' && options.filename !== ':memory:') {
      try {
        this.database.exec('PRAGMA journal_mode = WAL;')
        // In WAL, NORMAL keeps every commit crash-safe against process death and only relaxes
        // durability against power loss at the most recent checkpoint, which trade-off is what
        // keeps large changeset commits from paying a full fsync under the write lock.
        this.database.exec('PRAGMA synchronous = NORMAL;')
      } catch {
        // Some filesystems cannot host WAL sidecar files. The database then keeps its previous
        // journal mode, which is exactly the behavior before WAL enablement was attempted.
      }
    }
  }

  /**
   * Dedicated read-only connection for pure read paths.
   *
   * Under WAL, statements on this connection never wait for the writer lock, so a large changeset
   * commit in this process (or a helper process) cannot block reads. Falls back to the writable
   * database when the reader cannot be opened: each `:memory:` connection owns a private
   * database, and a crashed WAL database may need to recover the `-shm` file before a read-only
   * connection can attach.
   */
  public get readDatabase(): Database.Database {
    if (this.filename === ':memory:' || this._readDatabaseFailed) {
      return this.database
    }
    if (this._readDatabase === undefined) {
      try {
        this._readDatabase = new Database(this.filename, {
          readonly: true,
          fileMustExist: true,
          timeout: this._busyTimeoutMs
        })
      } catch {
        this._readDatabaseFailed = true
        return this.database
      }
    }
    return this._readDatabase
  }

  /**
   * Closes this connection.
   *
   * libsql 0.5.29 does not finalize prepared statements when `Database.close()` runs. On Windows,
   * those statements may keep the database file locked until V8 collects them or the process
   * exits (https://github.com/tursodatabase/libsql-js/issues/228). Callers must therefore not
   * assume that a disposed database can be unlinked immediately in the same process. The CLI's
   * supported way to delete a recently used `.univer` file on Windows is to stop the daemon first.
   */
  public dispose(): void {
    if (this._disposed) {
      return
    }
    this._disposed = true
    if (this._readDatabase !== undefined) {
      try {
        this._readDatabase.close()
      } catch {
        // Like the writable connection, the reader can keep unfinalized statement handles on
        // Windows; the handle then releases when the process exits instead of at close().
      }
      this._readDatabase = undefined
    }
    if (this.journalMode === 'wal' && this.filename !== ':memory:') {
      try {
        this.database.exec('PRAGMA wal_checkpoint(TRUNCATE);')
      } catch {
        // Databases left in a non-WAL journal mode have no WAL to checkpoint.
      }
    }
    this.database.close()
  }
}

/**
 * Runs a synchronous SQLite operation atomically. Adapter calls made inside a larger gateway
 * transaction use a savepoint so schema initialization and migration can share one outer commit.
 */
export function runUniverfileSQLiteTransaction<T>(
  database: Database.Database,
  operation: () => T
): T {
  if (!database.inTransaction) {
    database.exec('BEGIN IMMEDIATE;')
    try {
      const result = operation()
      database.exec('COMMIT;')
      return result
    } catch (error) {
      if (database.inTransaction) {
        database.exec('ROLLBACK;')
      }
      throw error
    }
  }

  const savepoint = `univerfile_nested_${savepointSequence}`
  savepointSequence += 1
  database.exec(`SAVEPOINT ${savepoint};`)
  try {
    const result = operation()
    database.exec(`RELEASE ${savepoint};`)
    return result
  } catch (error) {
    if (database.inTransaction) {
      database.exec(`ROLLBACK TO ${savepoint};`)
      database.exec(`RELEASE ${savepoint};`)
    }
    throw error
  }
}

function validateOptions(options: UniverfileSQLiteConnectionOptions): void {
  if (typeof options.filename !== 'string' || options.filename.length === 0) {
    throw new TypeError('filename must be a non-empty string')
  }
  if (
    options.busyTimeoutMs !== undefined &&
    (!Number.isSafeInteger(options.busyTimeoutMs) || options.busyTimeoutMs < 0)
  ) {
    throw new TypeError('busyTimeoutMs must be a non-negative safe integer')
  }
  if (
    options.journalMode !== undefined &&
    options.journalMode !== 'default' &&
    options.journalMode !== 'wal'
  ) {
    throw new TypeError("journalMode must be 'default' or 'wal'")
  }
  if (options.payloadCompression !== undefined && typeof options.payloadCompression !== 'boolean') {
    throw new TypeError('payloadCompression must be a boolean')
  }
}
