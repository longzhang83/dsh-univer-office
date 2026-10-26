import type { UniverService } from '../../service/univer-service.ts'

/** Start or reuse the plugin-owned Gateway. */
export function gatewayStartRoute(service: UniverService) {
  return service.ensureGateway()
}
