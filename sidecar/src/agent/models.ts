import { streamFromRegistry, type ProviderRegistry } from "../providers.js"
import type { ModelClient } from "./executor.js"

export function defaultModelClient(registry: ProviderRegistry): ModelClient {
  return {
    async *stream(messages, opts) {
      const iter = await streamFromRegistry(registry, messages, {
        provider: opts?.provider,
        model: opts?.model,
        stream: { signal: opts?.signal, onUsage: opts?.onUsage },
      })
      for await (const ev of iter) yield ev
    },
  }
}
