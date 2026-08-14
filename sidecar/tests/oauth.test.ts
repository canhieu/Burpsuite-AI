import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { spawn } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CodexOAuth } from "../src/auth/codex.js"
import { createAuthManager } from "../src/auth/manager.js"
import type { SidecarConfig } from "../src/config.js"

// Start the fixture oauth mock once for this suite.
let oauthProc: ReturnType<typeof spawn> | null = null
const OAUTH_PORT = 19003

beforeAll(async () => {
  const fixDir = "/mnt/e/lab/burp/fixtures/dist/index.js"
  oauthProc = spawn("node", [fixDir, "oauth", "--port", String(OAUTH_PORT)], {
    cwd: "/mnt/e/lab/burp/fixtures",
    stdio: "ignore",
  })
  await new Promise((r) => setTimeout(r, 1200))
})

afterAll(() => {
  oauthProc?.kill("SIGKILL")
})

function testConfig(authPath: string): SidecarConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    authToken: "t",
    dataDir: mkdtempSync(join(tmpdir(), "burp-agent-test-")),
    localOnly: false,
    providers: {
      openai: { enabled: true, apiKeyEnv: "OPENAI_API_KEY", baseUrl: "http://127.0.0.1:19002/v1" },
      anthropic: { enabled: false, apiKeyEnv: "ANTHROPIC_API_KEY", baseUrl: "http://127.0.0.1:19002/v1" },
      deepseek: { enabled: false, apiKeyEnv: "DEEPSEEK_API_KEY", baseUrl: "http://127.0.0.1:19002/v1" },
      ollama: { enabled: false, baseUrl: "http://127.0.0.1:11434/v1" },
    },
    notifications: {},
    logging: { level: "error", redactSecrets: true },
    models: {
      roles: {
        planner: { provider: "openai", model: "m" },
        executor: { provider: "openai", model: "m" },
        reviewer: { provider: "openai", model: "m" },
        fast: { provider: "openai", model: "m" },
      },
    },
    oauth: {
      openai: {
        issuer: `http://127.0.0.1:${OAUTH_PORT}`,
        clientId: "test-client",
        scope: "openid offline_access",
        tokenEndpoint: `http://127.0.0.1:${OAUTH_PORT}/oauth/token`,
        deviceEndpoint: `http://127.0.0.1:${OAUTH_PORT}/api/accounts/deviceauth/usercode`,
        deviceTokenEndpoint: `http://127.0.0.1:${OAUTH_PORT}/api/accounts/deviceauth/token`,
        deviceCallback: `http://127.0.0.1:${OAUTH_PORT}/deviceauth/callback`,
        verificationUri: `http://127.0.0.1:${OAUTH_PORT}/codex/device`,
      },
      anthropic: {
        issuer: `http://127.0.0.1:${OAUTH_PORT}`,
        clientId: "test-client",
        scope: "openid",
        tokenEndpoint: `http://127.0.0.1:${OAUTH_PORT}/oauth/token`,
      },
    },
  }
}

async function approveDevice(code: string): Promise<void> {
  await fetch(`http://127.0.0.1:${OAUTH_PORT}/oauth/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_code: code }),
  })
}

describe("CodexOAuth device flow (against mock)", () => {
  it("runs full device flow: pending -> approve -> success + writes auth.json", async () => {
    const authPath = join(mkdtempSync(join(tmpdir(), "codex-oauth-")), "auth.json")
    const o = new CodexOAuth({ config: testConfig(authPath).oauth!.openai!, authPath })

    const start = await o.startDeviceCode()
    expect(start.state).toBe("pending")
    expect(start.userCode).toBeTruthy()
    expect(start.deviceCode).toBeTruthy()
    expect(o.hasSession()).resolves.toBe(false)

    // first poll should be pending (not yet approved)
    const pending = await o.pollDeviceCode(start.flowId, start.deviceCode!, start.interval)
    expect(pending.state).toBe("pending")

    await approveDevice(start.deviceCode!)
    const result = await o.pollDeviceCode(start.flowId, start.deviceCode!, start.interval)
    expect(result.state).toBe("success")
    expect(result.accessToken).toBeTruthy()

    expect(await o.hasSession()).toBe(true)
    const stored = await o.storedTokens()
    expect(stored?.access_token).toBeTruthy()
    expect(stored?.refresh_token).toBeTruthy()

    // refresh works
    const refreshed = await o.refresh()
    expect(refreshed).toBe(true)

    // logout removes file
    await o.logout(false)
    expect(await o.hasSession()).toBe(false)
  })

  it("rejects wrong flow / bad token via manager", async () => {
    const authPath = join(mkdtempSync(join(tmpdir(), "codex-mgr-")), "auth.json")
    const m = createAuthManager({ ...testConfig(authPath), oauth: { openai: { ...testConfig(authPath).oauth!.openai! } } }, { authPath })
    const start = await m.loginStart("openai", "device")
    expect(start["state"]).toBe("pending")
    expect(start["userCode"]).toBeTruthy()

    const before = await m.status("openai")
    expect(before.method).toBe("none")

    await approveDevice(String(start["deviceCode"]))
    // poll through manager with the flowId
    const poll = await m.loginPoll("openai", String(start["flowId"]), String(start["deviceCode"]), 1)
    expect(poll["state"]).toBe("success")

    const after = await m.status("openai")
    expect(after.method).toBe("oauth")

    const tok = await m.accessToken("openai")
    expect(tok).toBeTruthy()
  })

  it("handles cancel", async () => {
    const authPath = join(mkdtempSync(join(tmpdir(), "codex-cancel-")), "auth.json")
    const o = new CodexOAuth({ config: testConfig(authPath).oauth!.openai!, authPath })
    const start = await o.startDeviceCode()
    expect(start.state).toBe("pending")
    o.cancel(start.flowId)
    const done = await o.runDeviceFlow(start.flowId, start.deviceCode!, start.interval ?? 1, 3)
    expect(done.state).toBe("error")
  })
})
