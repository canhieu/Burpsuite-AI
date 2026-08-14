import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { startOauthServer, type OauthServerHandle } from "../src/oauth_mock.js"

interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  interval: number
  expires_in: number
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  token_type: string
}

describe("oauth device-flow mock", () => {
  let handle: OauthServerHandle
  let base: string

  beforeAll(async () => {
    handle = await startOauthServer()
    base = handle.url
  })

  afterAll(async () => {
    await handle.close()
  })

  async function requestDeviceCode(): Promise<DeviceCodeResponse> {
    const res = await fetch(`${base}/oauth/device/code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: "fixture-client", scope: "read" }),
    })
    expect(res.status).toBe(200)
    return (await res.json()) as DeviceCodeResponse
  }

  it("device code endpoint returns pending flow fields", async () => {
    const code = await requestDeviceCode()
    expect(code.user_code).toBe("ABCD-1234")
    expect(code.interval).toBe(1)
    expect(code.expires_in).toBe(600)
    expect(code.device_code.length).toBeGreaterThan(0)
  })

  it("token returns authorization_pending until approve, then success", async () => {
    const code = await requestDeviceCode()

    const pending = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: code.device_code,
      }),
    })
    expect(pending.status).toBe(400)
    const pendingJson = (await pending.json()) as { error: string }
    expect(pendingJson.error).toBe("authorization_pending")

    const approve = await fetch(`${base}/oauth/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: code.device_code }),
    })
    expect(approve.status).toBe(200)

    const token = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: code.device_code,
      }),
    })
    expect(token.status).toBe(200)
    const tokenJson = (await token.json()) as TokenResponse
    expect(tokenJson.token_type).toBe("bearer")
    expect(tokenJson.access_token.startsWith("at_")).toBe(true)
    expect(tokenJson.refresh_token.startsWith("rt_")).toBe(true)
  })

  it("refresh grant returns fresh tokens", async () => {
    const code = await requestDeviceCode()
    await fetch(`${base}/oauth/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: code.device_code }),
    })
    const tokenRes = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: code.device_code,
      }),
    })
    const first = (await tokenRes.json()) as TokenResponse

    const refreshRes = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: first.refresh_token,
      }),
    })
    expect(refreshRes.status).toBe(200)
    const refreshed = (await refreshRes.json()) as TokenResponse
    expect(refreshed.access_token.startsWith("at_")).toBe(true)
    expect(refreshed.refresh_token.startsWith("rt_")).toBe(true)
    expect(refreshed.refresh_token).not.toBe(first.refresh_token)
  })

  it("rejects invalid refresh token", async () => {
    const res = await fetch(`${base}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: "nope" }),
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { error: string }
    expect(json.error).toBe("invalid_grant")
  })
})
