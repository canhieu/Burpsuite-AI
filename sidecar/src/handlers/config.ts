import { writeFileSync, mkdirSync } from "node:fs"
import { overridesFilePath } from "../config.js"
import type { HandlerGroup } from "./types.js"

export function configHandlers(): HandlerGroup {
  return {
    "config.get": (_params, _ctx, services) => {
      const providers: Record<string, unknown> = {}
      for (const [name, p] of Object.entries(services.config.providers)) {
        providers[name] = {
          enabled: p.enabled,
          baseUrl: p.baseUrl,
          apiKeyEnv: p.apiKeyEnv ?? null,
          hasKey: !!p.apiKey,
        }
      }
      return {
        providers,
        models: {
          roles: services.config.models.roles,
        },
        dataDir: services.config.dataDir,
      }
    },
    "config.set": (params, _ctx, services) => {
      const patch = params["providers"]
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        throw new Error("config.set requires providers object")
      }
      // Apply to in-memory config.
      for (const [name, raw] of Object.entries(patch as Record<string, Record<string, unknown>>)) {
        const base = services.config.providers[name] ?? { enabled: false, baseUrl: "" }
        const updated = { ...base }
        if (typeof raw["enabled"] === "boolean") updated.enabled = raw["enabled"]
        if (typeof raw["baseUrl"] === "string" && raw["baseUrl"].trim().length > 0) updated.baseUrl = raw["baseUrl"].trim()
        if (raw["apiKey"] !== undefined) {
          const v = raw["apiKey"]
          if (typeof v === "string" && v.trim().length > 0) {
            updated.apiKey = v.trim()
          } else {
            delete updated.apiKey
          }
        }
        services.config.providers[name] = updated
      }
      // Persist to overrides file (mask the key on disk? No - keep plaintext for local tooling).
      persistOverrides(services.config.dataDir, services.config.providers)
      services.log("info", "config.set applied", { providers: Object.keys(patch as Record<string, unknown>) })
      // Rebuild registry so new baseUrl/apiKey take effect immediately.
      if (services.rebuildRegistry) services.rebuildRegistry()
      return { ok: true, providers: snapshot(services.config.providers) }
    },
  }
}

function snapshot(providers: Record<string, { enabled: boolean; baseUrl: string }>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, p] of Object.entries(providers)) {
    out[name] = { enabled: p.enabled, baseUrl: p.baseUrl, hasKey: !!(p as { apiKey?: string }).apiKey }
  }
  return out
}

export function persistOverrides(
  dataDir: string,
  providers: Record<string, { enabled: boolean; baseUrl: string; apiKey?: string; apiKeyEnv?: string }>,
): void {
  try {
    mkdirSync(dataDir, { recursive: true })
    const file = overridesFilePath(dataDir)
    const out: Record<string, { enabled?: boolean; baseUrl?: string; apiKey?: string }> = {}
    for (const [name, p] of Object.entries(providers)) {
      const row: { enabled?: boolean; baseUrl?: string; apiKey?: string } = {}
      if (typeof p.enabled === "boolean") row.enabled = p.enabled
      if (typeof p.baseUrl === "string" && p.baseUrl.trim()) row.baseUrl = p.baseUrl.trim()
      if (typeof p.apiKey === "string" && p.apiKey.trim()) row.apiKey = p.apiKey.trim()
      if (Object.keys(row).length > 0) out[name] = row
    }
    writeFileSync(file, JSON.stringify({ providers: out }, null, 2), { mode: 0o600 })
  } catch {
    /* non-fatal: settings persist at next boot via config file */
  }
}
