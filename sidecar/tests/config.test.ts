import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig, providerApiKey, overridesFilePath, type SidecarConfig, type ProviderConfig } from "../src/config.js"
import { createProviderRegistry } from "../src/providers.js"
import { configHandlers, persistOverrides } from "../src/handlers/config.js"

function baseConfig(dataDir: string): SidecarConfig {
  return {
    host: "127.0.0.1",
    port: 8570,
    authToken: "t",
    dataDir,
    localOnly: true,
    providers: {
      openai: { enabled: false, apiKeyEnv: "OPENAI_API_KEY", baseUrl: "https://api.openai.com/v1" },
      anthropic: { enabled: false, apiKeyEnv: "ANTHROPIC_API_KEY", baseUrl: "https://api.anthropic.com/v1" },
      deepseek: { enabled: false, apiKeyEnv: "DEEPSEEK_API_KEY", baseUrl: "https://api.deepseek.com/v1" },
      ollama: { enabled: false, baseUrl: "http://127.0.0.1:11434/v1" },
    },
    notifications: {},
    logging: { level: "error", redactSecrets: true },
    models: {
      roles: {
        planner: { provider: "openai", model: "gpt-4o" },
        executor: { provider: "openai", model: "gpt-4o-mini" },
        reviewer: { provider: "openai", model: "gpt-4o" },
        fast: { provider: "deepseek", model: "deepseek-chat" },
      },
    },
  }
}

function mockServices(dataDir: string) {
  const config = baseConfig(dataDir)
  const services = {
    config,
    store: {} as never,
    registry: {} as never,
    startTime: 0,
    sidecarVersion: "test",
    log: () => undefined,
    getProviderStatuses: async () => [],
    rebuildRegistry: undefined as (() => void | Promise<void>) | undefined,
  }
  return { config, services }
}

import { mkdirSync } from "node:fs"

describe("config.overrides.json merge", () => {
  let dir: string
  let dataDir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "burp-cfg-"))
    dataDir = join(dir, "data")
    mkdtempSync(dataDir) // ensure dir exists (loadConfig resolves dataDir under cwd)
    rmSync(dataDir, { recursive: true, force: true })
    mkdirSync(dataDir, { recursive: true })
    // Write a runtime override file as config.set would.
    writeFileSync(
      join(dataDir, "config.overrides.json"),
      JSON.stringify({
        providers: {
          openai: { enabled: true, baseUrl: "https://api.shineshop.dev/v1", apiKey: "sk-relay-123" },
          ollama: { enabled: false },
        },
      }),
    )
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it("merges overrides into a config loaded from defaults", () => {
    const cfg = loadConfig({}, dir)
    const o = cfg.providers["openai"]
    expect(o.enabled).toBe(true)
    expect(o.baseUrl).toBe("https://api.shineshop.dev/v1")
    expect(o.apiKey).toBe("sk-relay-123")
  })

  it("providerApiKey returns env first, then stored apiKey", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "burp-cfg2-"))
    const cfg = baseConfig(dir2)
    cfg.providers["openai"].apiKey = "sk-stored"
    cfg.providers["openai"].apiKeyEnv = "OPENAI_API_KEY"
    // env set -> env wins
    process.env["OPENAI_API_KEY"] = "sk-env"
    expect(providerApiKey(cfg, "openai")).toBe("sk-env")
    // env cleared -> stored key wins
    delete process.env["OPENAI_API_KEY"]
    expect(providerApiKey(cfg, "openai")).toBe("sk-stored")
    // no key anywhere -> undefined
    cfg.providers["openai"].apiKey = undefined
    expect(providerApiKey(cfg, "openai")).toBeUndefined()
    rmSync(dir2, { recursive: true, force: true })
  })

  it("persistOverrides writes masked-free overrides file", () => {
    const dir3 = mkdtempSync(join(tmpdir(), "burp-cfg3-"))
    const cfg = baseConfig(dir3)
    cfg.providers["openai"] = { ...cfg.providers["openai"], enabled: true, baseUrl: "https://relay.test/v1", apiKey: "sk-x" }
    persistOverrides(dir3, cfg.providers as Record<string, ProviderConfig>)
    const file = readFileSync(overridesFilePath(dir3), "utf8")
    const parsed = JSON.parse(file)
    expect(parsed.providers.openai.apiKey).toBe("sk-x")
    expect(parsed.providers.openai.baseUrl).toBe("https://relay.test/v1")
    rmSync(dir3, { recursive: true, force: true })
  })
})

describe("config handlers", () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "burp-cfg-h-"))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it("config.get returns providers + hasKey flag", () => {
    const { services } = mockServices(dir)
    const out = configHandlers()["config.get"]({}, {} as never, services) as {
      providers: Record<string, { hasKey: boolean }>
    }
    expect(out.providers["openai"].hasKey).toBe(false)
  })

  it("config.set applies + persists + rebuilds registry", async () => {
    const cfgDir = join(dir, "cfgset")
    mkdirSync(cfgDir, { recursive: true })
    // Write a minimal config.json so loadConfig resolves dataDir to cfgDir/data consistently.
    writeFileSync(
      join(cfgDir, "config.json"),
      JSON.stringify({ dataDir: "data", host: "127.0.0.1", port: 8570, authToken: "t" }),
    )
    const { config, services } = mockServices(join(cfgDir, "data"))
    const rebuilt: unknown[] = []
    services.rebuildRegistry = () => {
      rebuilt.push(true)
    }
    const handlers = configHandlers()
    const res = handlers["config.set"](
      {
        providers: {
          openai: { enabled: true, baseUrl: "https://api.shineshop.dev/v1", apiKey: "sk-ui-key" },
        },
      },
      {} as never,
      services,
    ) as { ok: boolean; providers: Record<string, { enabled: boolean; baseUrl: string; hasKey: boolean }> }
    expect(res.ok).toBe(true)
    expect(config.providers["openai"].enabled).toBe(true)
    expect(config.providers["openai"].baseUrl).toBe("https://api.shineshop.dev/v1")
    expect(config.providers["openai"].apiKey).toBe("sk-ui-key")
    expect(res.providers["openai"].hasKey).toBe(true)
    expect(rebuilt.length).toBe(1)
    // persisted
    const file = JSON.parse(readFileSync(overridesFilePath(config.dataDir), "utf8"))
    expect(file.providers.openai.apiKey).toBe("sk-ui-key")
    // reload merges (cwd = cfgDir)
    const reloaded = loadConfig({}, cfgDir)
    expect(reloaded.providers["openai"].apiKey).toBe("sk-ui-key")
  })

  it("config.set with empty apiKey clears stored key", () => {
    const { config, services } = mockServices(dir)
    config.providers["openai"].apiKey = "old"
    configHandlers()["config.set"]({ providers: { openai: { apiKey: "   " } } }, {} as never, services)
    expect(config.providers["openai"].apiKey).toBeUndefined()
  })
})
