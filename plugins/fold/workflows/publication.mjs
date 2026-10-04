import { createPlatformAdapter } from '../adapters/registry.mjs'
import { publishApprovedBatch } from './lifecycle.mjs'

/** Selects an internal platform adapter while keeping Fold MCP calls in the shared workflow. */
export async function publishReadyListings({
  fold,
  platform,
  adapterOptions,
  resolveInference,
  createAdapter = createPlatformAdapter,
}) {
  const adapter = createAdapter(platform, adapterOptions)
  return publishApprovedBatch({ fold, adapter, resolveInference })
}
