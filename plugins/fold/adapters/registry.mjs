import { createDepopAdapter, DEPOP_ADAPTER_ID } from './depop/adapter.mjs'
import { createVintedAdapter, VINTED_ADAPTER_ID } from './vinted/adapter.mjs'
import { assertPlatformAdapter } from './contract.mjs'

const ADAPTER_FACTORIES = new Map([
  [DEPOP_ADAPTER_ID, createDepopAdapter],
  [VINTED_ADAPTER_ID, createVintedAdapter],
])

export function supportedAdapterPlatforms() {
  return [...ADAPTER_FACTORIES.keys()]
}

export function createPlatformAdapter(platform, options = {}) {
  const factory = ADAPTER_FACTORIES.get(platform)
  if (factory === undefined) {
    throw new Error(`No qualified internal Fold adapter is available for ${platform}`)
  }
  return assertPlatformAdapter(factory(options))
}
