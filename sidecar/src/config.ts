import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

export interface ProviderConfig {
  enabled: boolean
  apiKeyEnv?: string
  baseUrl: string
}

export interface SidecarConfig {
  host: string
  port: number
  authToken: string
  dataDir: string
  localOnly: boolean
  providers: Record<string, ProviderConfig>
  notifications: {
    telegram?: { botTokenEnv?: string; chatIdEnv?: string }
    webhook?: { urlEnv?: string }
  }
  logging: { level: "debug" | "info" | "warn" | "error"; redactSecrets: boolean }
  oauth?: {
    openai?: {
      issuer?: string
      clientId?: string
      scope?: string
      tokenEndpoint?: string
      deviceEndpoint?: string
      authorizeEndpoint?: string
      redirectUri?: string
    }
    anthropic?: {
      issuer?: string
      clientId?: string
      scope?: string
      tokenEndpoint?: string
      deviceEndpoint?: string
      authorizeEndpoint?: string
      redirectUri?: string
    }
  }
  models: {
    roles: Record<"planner" | "executor" | "reviewer" | "fast", { provider: string; model: string }>
    openai?: { default?: string; extra?: string[] }
    anthropic?: { default?: string; extra?: string[] }
    deepseek?: { default?: string; extra?: string[] }
    ollama?: { default?: string; extra?: string[] }
  }
}

const DEFAULT_ROLES: SidecarConfig["models"]["roles"] = {
  planner: { provider: "openai", model: "gpt-4o" },
  executor: { provider: "openai", model: "gpt-4o-mini" },
  reviewer: { provider: "openai", model: "gpt-4o" },
  fast: { provider: "deepseek", model: "deepseek-chat" },
}

const DEFAULT_CONFIG: SidecarConfig = {
  host: "127.0.0.1",
  port: 8570,
  authToken: "change-me",
  dataDir: "data",
  localOnly: false,
  providers: {
    openai: { enabled: false, apiKeyEnv: "OPENAI_API_KEY", baseUrl: "https://api.openai.com/v1" },
    anthropic: { enabled: false, apiKeyEnv: "ANTHROPIC_API_KEY", baseUrl: "https://api.anthropic.com/v1" },
    deepseek: { enabled: false, apiKeyEnv: "DEEPSEEK_API_KEY", baseUrl: "https://api.deepseek.com/v1" },
    ollama: { enabled: false, baseUrl: "http://127.0.0.1:11434/v1" },
  },
  notifications: {
    telegram: { botTokenEnv: "TELEGRAM_BOT_TOKEN", chatIdEnv: "TELEGRAM_CHAT_ID" },
    webhook: { urlEnv: "AGENT_WEBHOOK_URL" },
  },
  logging: { level: "info", redactSecrets: true },
  models: { roles: DEFAULT_ROLES },
  oauth: {
    openai: {
      issuer: "https://auth.openai.com",
      clientId: "codex_cli_7tGxSIrWQdoyuPXD",
      scope: "openid email profile offline_access model.request model_install",
      tokenEndpoint: "https://auth.openai.com/oauth/token",
      deviceEndpoint: "https://auth.openai.com/oauth/device/code",
    },
    anthropic: {
      issuer: "https://claude.ai",
      clientId: "claude-code",
      scope: "openid email profile offline_access",
      tokenEndpoint: "https://claude.ai/api/oauth/token",
      authorizeEndpoint: "https://claude.ai/oauth/authorize",
      redirectUri: "http://127.0.0.1:14574/oauth/callback",
    },
  },
}

export type RawConfig = Partial<SidecarConfig> & {
  providers?: Record<string, Partial<ProviderConfig>>
  models?: { roles?: Partial<Record<keyof SidecarConfig["models"]["roles"], Partial<{ provider: string; model: string }>>> }
}

function loadFile(path: string): RawConfig | null {
  try {
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, "utf8")) as RawConfig
  } catch {
    return null
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): SidecarConfig {
  const candidates = [env["CONFIG_PATH"], resolve(cwd, "config.json"), resolve(cwd, "config.example.json")].filter(
    (p): p is string => !!p,
  )
  let raw: RawConfig = {}
  for (const p of candidates) {
    const loaded = loadFile(p)
    if (loaded) {
      raw = loaded
      break
    }
  }

  const cfg = structuredClone(DEFAULT_CONFIG)
  if (raw.host !== undefined) cfg.host = String(raw.host)
  if (raw.port !== undefined) cfg.port = Number(raw.port)
  if (raw.authToken !== undefined) cfg.authToken = String(raw.authToken)
  if (raw.dataDir !== undefined) cfg.dataDir = String(raw.dataDir)
  if (raw.localOnly !== undefined) cfg.localOnly = Boolean(raw.localOnly)
  if (raw.logging) {
    if (raw.logging.level) cfg.logging.level = raw.logging.level
    if (raw.logging.redactSecrets !== undefined) cfg.logging.redactSecrets = Boolean(raw.logging.redactSecrets)
  }

  if (raw.providers) {
    for (const [name, p] of Object.entries(raw.providers)) {
      const base = cfg.providers[name] ?? { enabled: false, baseUrl: "" }
      cfg.providers[name] = {
        ...base,
        ...p,
        baseUrl: p.baseUrl ?? base.baseUrl,
      }
    }
  }

  if (raw.notifications) {
    if (raw.notifications.telegram) cfg.notifications.telegram = { ...cfg.notifications.telegram, ...raw.notifications.telegram }
    if (raw.notifications.webhook) cfg.notifications.webhook = { ...cfg.notifications.webhook, ...raw.notifications.webhook }
  }

  if (raw.models) {
    if (raw.models.roles) {
      for (const role of Object.keys(DEFAULT_ROLES) as Array<keyof typeof DEFAULT_ROLES>) {
        const r = raw.models.roles[role]
        if (r) cfg.models.roles[role] = { provider: r.provider ?? cfg.models.roles[role].provider, model: r.model ?? cfg.models.roles[role].model }
      }
    }
    if (raw.models.openai) cfg.models.openai = raw.models.openai
    if (raw.models.anthropic) cfg.models.anthropic = raw.models.anthropic
    if (raw.models.deepseek) cfg.models.deepseek = raw.models.deepseek
    if (raw.models.ollama) cfg.models.ollama = raw.models.ollama
  }

  if (raw.oauth) {
    cfg.oauth = { openai: { ...cfg.oauth?.openai, ...raw.oauth.openai }, anthropic: { ...cfg.oauth?.anthropic, ...raw.oauth.anthropic } }
  }

  return cfg
}

const API_KEY_ENVS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY"] as const

export function resolveApiKey(envName: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!envName) return undefined
  if (!(API_KEY_ENVS as readonly string[]).includes(envName)) return undefined
  const v = env[envName]
  return v && v.length > 0 ? v : undefined
}
