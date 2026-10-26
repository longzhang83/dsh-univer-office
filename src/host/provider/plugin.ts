import type { Context } from '@deepseek-ai/cordis'
import type { ResolvedConfig } from '../config.ts'
import { GatewayUniverService } from './gateway-univer-service.ts'

/** Mount the Univer Service Provider. */
export function apply(ctx: Context, config: ResolvedConfig): void {
  new GatewayUniverService(ctx, config)
}

export const name = 'univer-provider'
