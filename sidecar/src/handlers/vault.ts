import type { HandlerGroup } from "./types.js"

const NAMESPACE = "vault"

export function vaultHandlers(): HandlerGroup {
  return {
    "vault.set": (params, _c, services) => {
      const namespace = String(params["namespace"] ?? "default")
      const key = String(params["key"] ?? "")
      const value = params["value"]
      if (!key) throw new Error("vault.set requires key")
      const all = (services.store.getSetting(NAMESPACE) as Record<string, Record<string, unknown>>) ?? {}
      const ns = all[namespace] ?? {}
      ns[key] = value
      all[namespace] = ns
      services.store.setSetting(NAMESPACE, all)
      return { stored: true, keychain: false }
    },
    "vault.get": (params, _c, services) => {
      const namespace = String(params["namespace"] ?? "default")
      const key = String(params["key"] ?? "")
      const all = (services.store.getSetting(NAMESPACE) as Record<string, Record<string, unknown>>) ?? {}
      const value = all[namespace]?.[key]
      if (value === undefined) throw new Error(`vault key not found: ${namespace}/${key}`)
      return { value, keychain: false }
    },
    "vault.delete": (params, _c, services) => {
      const namespace = String(params["namespace"] ?? "default")
      const key = String(params["key"] ?? "")
      const all = (services.store.getSetting(NAMESPACE) as Record<string, Record<string, unknown>>) ?? {}
      const ns = all[namespace] ?? {}
      if (!(key in ns)) throw new Error(`vault key not found: ${namespace}/${key}`)
      delete ns[key]
      all[namespace] = ns
      services.store.setSetting(NAMESPACE, all)
      return { deleted: true, keychain: false }
    },
  }
}
