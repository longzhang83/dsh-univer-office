/** Browser-safe Gateway process state returned by the Host API. */
export interface GatewayStatus {
  readonly phase: 'stopped' | 'starting' | 'running' | 'failed'
  readonly gateway: string | null
  readonly owned: boolean
  readonly reason?: string
}

/** Result of ensuring that the bundled Gateway is available. */
export type EnsureGatewayResult =
  | { readonly ok: true; readonly gateway: string; readonly reused: boolean }
  | { readonly ok: false; readonly reason: string }

/** Host status visible to the DSH browser client. */
export interface UniverStatus {
  readonly gateway: GatewayStatus
  readonly unitContent: 'bundled' | 'unavailable'
}
