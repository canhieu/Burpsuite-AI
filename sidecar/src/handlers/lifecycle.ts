import type { HandlerGroup } from "./types.js"

export function lifecycleHandlers(): HandlerGroup {
  return {
    "agent.ping": (_p, _c, services) => ({
      pong: true,
      version: services.sidecarVersion,
      uptimeMs: Date.now() - services.startTime,
    }),
    "agent.hello": async (_p, _c, services) => {
      const providerStatus = await services.getProviderStatuses()
      return { ok: true, version: services.sidecarVersion, providerStatus }
    },
  }
}
