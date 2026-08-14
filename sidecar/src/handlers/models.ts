import type { ModelInfo } from "../types.js"
import type { HandlerGroup } from "./types.js"

export function modelsHandlers(): HandlerGroup {
  return {
    "models.list": async (params, _c, services) => {
      const provider = params["provider"]
      if (provider) {
        const adapter = services.registry.get(String(provider))
        if (!adapter) return { models: [], provider }
        return { models: await adapter.listModels(), provider }
      }
      return { models: await services.registry.listModels() }
    },
    "models.resolve": (params, _c, services) => {
      const alias = params["alias"]
      if (typeof alias !== "string" || !alias) throw new Error("models.resolve requires alias")
      const role = services.config.models.roles[alias as keyof typeof services.config.models.roles]
      if (role) {
        const info: ModelInfo = { id: role.model, provider: role.provider }
        return { model: info, alias }
      }
      const resolved = services.registry.resolveModel(alias)
      if (!resolved) throw new Error(`unknown model alias: ${alias}`)
      return { model: resolved, alias }
    },
  }
}
