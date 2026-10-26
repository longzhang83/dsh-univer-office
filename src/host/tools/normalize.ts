import { isRecord } from '../adapters/gateway/mapping.ts'
import type { UniverOperationResult } from '../service/types.ts'

/**
 * Drop the Gateway success envelope from a tool result.
 *
 * The bundled Gateway attaches `error: { code: 1, message: "" }` to every
 * response; in the Gateway wire contract `code: 1` means success
 * (`@univerjs/protocol` `ErrorCode.OK = 1`) and `code: 0` means failure.
 * Failures are already surfaced as thrown errors by the provider, so a
 * successful tool result only carries the envelope as noise. Stripping it
 * here keeps the value the model receives focused on the meaningful fields
 * (worktreeId, unitId, status, …) instead of a misleading `error` member.
 */
export function stripGatewaySuccessEnvelope(value: UniverOperationResult): UniverOperationResult {
  const { result } = value
  if (!isRecord(result) || !isRecord(result.error) || result.error.code !== 1) {
    return value
  }
  const { error: _envelope, ...rest } = result
  return { ...value, result: rest }
}
