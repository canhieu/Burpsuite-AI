import type { HandlerGroup } from "./types.js"

function getByPath(obj: unknown, path: string): unknown {
  const parts = path.split(".")
  let cur: unknown = obj
  for (const part of parts) {
    if (cur && typeof cur === "object" && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part]
    } else {
      return undefined
    }
  }
  return cur
}

export function settingsHandlers(): HandlerGroup {
  return {
    "settings.get": (params, _c, services) => {
      const all = services.store.getAllSettings()
      const paths = Array.isArray(params["paths"]) ? (params["paths"] as string[]) : undefined
      if (!paths || paths.length === 0) return { settings: all }
      const settings: Record<string, unknown> = {}
      for (const p of paths) {
        const v = getByPath(all, p)
        if (v !== undefined) settings[p] = v
      }
      return { settings }
    },
    "settings.set": (params, _c, services) => {
      const patch = params["patch"]
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        throw new Error("settings.set requires an object patch")
      }
      for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
        services.store.setSetting(k, v)
      }
      return { settings: services.store.getAllSettings() }
    },
  }
}
