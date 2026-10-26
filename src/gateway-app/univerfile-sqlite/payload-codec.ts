import { gunzipSync, gzipSync } from 'node:zlib'

const BINARY_TAG = '__univerCollaborationBinary'

/**
 * Marker prefixed to compressed stored payloads.
 *
 * Plain payloads are always JSON text starting with `{` or `[`, so the prefix can never collide
 * with a legacy uncompressed row. Readers probe on this marker instead of relying on any schema
 * change, which keeps existing (uncompressed) rows readable without a data migration.
 */
export const COMPRESSED_PAYLOAD_PREFIX = 'univer-z1:'

/** Payloads smaller than this gain little from gzip and stay stored as plain JSON. */
export const DEFAULT_PAYLOAD_COMPRESSION_MIN_BYTES = 4_096

export interface StoredPayloadEncodeOptions {
  /** When false, the payload is stored as plain JSON regardless of size. */
  readonly compress?: boolean
  readonly minBytes?: number
}

/** JSON-encodes a payload value with the collaboration binary wrapper, never compressed. */
export function encodePayloadJson(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) => {
    if (current instanceof Uint8Array) {
      return {
        [BINARY_TAG]: Buffer.from(current).toString('base64')
      }
    }
    return current
  })
}

/** Decodes a stored payload value, transparently decompressing rows written by newer writers. */
export function decodeStoredPayload<T>(payload: string): T {
  if (!payload.startsWith(COMPRESSED_PAYLOAD_PREFIX)) {
    return decodePayloadJson<T>(payload)
  }
  const compressed = Buffer.from(payload.slice(COMPRESSED_PAYLOAD_PREFIX.length), 'base64')
  return decodePayloadJson<T>(gunzipSync(compressed).toString('utf8'))
}

/**
 * Encodes a payload for storage, optionally gzip-compressing it behind the marker prefix.
 *
 * Compression happens outside write transactions so the extra CPU never lengthens the SQLite
 * write lock. Callers should only enable it for changeset/snapshot payloads; small or frequently
 * compared values stay plain.
 */
export function encodeStoredPayload(
  value: unknown,
  options: StoredPayloadEncodeOptions = {}
): string {
  const json = encodePayloadJson(value)
  const minBytes = options.minBytes ?? DEFAULT_PAYLOAD_COMPRESSION_MIN_BYTES
  if (options.compress !== true || Buffer.byteLength(json) < minBytes) {
    return json
  }
  return COMPRESSED_PAYLOAD_PREFIX + gzipSync(Buffer.from(json, 'utf8')).toString('base64')
}

function decodePayloadJson<T>(payload: string): T {
  return JSON.parse(payload, (_key, current: unknown) => {
    if (isBinaryEncoding(current)) {
      return Uint8Array.from(Buffer.from(current[BINARY_TAG], 'base64'))
    }
    return current
  }) as T
}

function isBinaryEncoding(value: unknown): value is Record<typeof BINARY_TAG, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.keys(value).length === 1 &&
    typeof (value as Record<string, unknown>)[BINARY_TAG] === 'string'
  )
}
