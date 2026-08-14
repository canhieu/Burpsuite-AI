import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { spawn } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProviderRegistry, streamFromRegistry } from "../src/providers.js"
import type { SidecarConfig } from "../src/config.js"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let provProc: ReturnType<typeof spawn> | null = null
const PROV_PORT = 19002

beforeAll(async () => {
  provProc = spawn("node", ["dist/index.js", "provider", "--port", String(PROV_PORT)], {
    cwd: "/mnt/e/lab/burp/fixtures",
    stdio: "ignore",
  })
  await sleep(1200)
})

afterAll(() => {
  provProc?.kill("SIGKILL")
})

function configFor(): SidecarConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    authToken: "t",
    dataDir: mkdtempSync(join(tmpdir(), "burp-provider-test-")),
    localOnly: true,
    providers: {
      openai: { enabled: true, baseUrl: `http://127.0.0.1:${PROV_PORT}/v1` },
      anthropic: { enabled: false, apiKeyEnv: "ANTHROPIC_API_KEY", baseUrl: "http://x" },
      deepseek: { enabled: false, apiKeyEnv: "DEEPSEEK_API_KEY", baseUrl: "http://x" },
      ollama: { enabled: false, baseUrl: "http://x" },
    },
    notifications: {},
    logging: { level: "error", redactSecrets: true },
    models: {
      roles: {
        planner: { provider: "openai", model: "gpt-5.1-codex" },
        executor: { provider: "openai", model: "gpt-5.1-codex-mini" },
        reviewer: { provider: "openai", model: "gpt-5.1-codex" },
        fast: { provider: "openai", model: "gpt-5.1-codex" },
      },
      openai: { default: "gpt-5.1-codex" },
    },
  }
}

describe("OpenAI OAuth session uses the Responses API (not chat/completions)", () => {
  it("streams text and surfaces tool calls via /v1/responses", async () => {
    const config = configFor()
    // No OPENAI_API_KEY; resolveToken supplies an OAuth (ChatGPT) token.
    delete process.env["OPENAI_API_KEY"]
    const registry = await createProviderRegistry(config, {
      resolveToken: async () => "sk-oauth-session-token",
    })
    const adapter = registry.get("openai")
    expect(adapter).toBeDefined()
    expect(adapter!.hasKey).toBe(false)

    const iter = await streamFromRegistry(registry, [{ role: "user", content: "hello world" }], {
      provider: "openai",
      model: "gpt-5.1-codex",
    })
    let text = ""
    const calls: unknown[] = []
    let done = false
    for await (const ev of iter) {
      if (ev.type === "text") text += String(ev.data)
      else if (ev.type === "tool_call") calls.push(ev.data)
      else if (ev.type === "done") done = true
      else if (ev.type === "error") throw new Error(String((ev.data as { message?: string })?.message ?? "err"))
    }
    expect(done).toBe(true)
    expect(text).toContain("Hello from mock model")
    expect(calls.length).toBe(0)
  })

  it("listModels returns codex models (not /v1/models) when OAuth", async () => {
    const config = configFor()
    delete process.env["OPENAI_API_KEY"]
    const registry = await createProviderRegistry(config, {
      resolveToken: async () => "sk-oauth-session-token",
    })
    const models = await registry.listModels()
    const codexModels = models.filter((m) => m.provider === "openai")
    expect(codexModels.length).toBeGreaterThan(0)
    expect(codexModels[0].id).toMatch(/codex|o3/)
  })
})
