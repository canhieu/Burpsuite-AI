import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { startProviderServer, type ProviderServerHandle } from "../src/provider_mock.js"

interface ChatBody {
  model: string
  messages: Array<{ role: string; content: string }>
  stream?: boolean
}

describe("provider mock", () => {
  let handle: ProviderServerHandle
  let base: string

  beforeAll(async () => {
    delete process.env.PROVIDER_FAIL
    handle = await startProviderServer()
    base = handle.url
  })

  afterAll(async () => {
    await handle.close()
  })

  it("GET /v1/models returns a model list", async () => {
    const res = await fetch(`${base}/v1/models`)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { data: unknown[] }
    expect(json.data.length).toBeGreaterThanOrEqual(1)
  })

  it("non-stream chat completion returns text with model echo", async () => {
    const body: ChatBody = { model: "gpt-mock-fast", messages: [{ role: "user", content: "hi" }] }
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      model: string
      choices: Array<{ message: { content: string } }>
    }
    expect(json.model).toBe("gpt-mock-fast")
    expect(json.choices[0].message.content).toContain("gpt-mock-fast")
  })

  it("streaming SSE works and terminates with [DONE]", async () => {
    const body: ChatBody = {
      model: "gpt-mock-1",
      messages: [{ role: "user", content: "tell me about requests" }],
      stream: true,
    }
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const text = await res.text()
    expect(text).toContain("data: [DONE]")
    expect(text).toContain('"content"')
  })

  it("detects tool intent and returns search_http_history tool_call", async () => {
    const body: ChatBody = {
      model: "gpt-mock-1",
      messages: [{ role: "user", content: "please use a tool to search history" }],
    }
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    const json = (await res.json()) as {
      choices: Array<{
        message: { tool_calls?: Array<{ function: { name: string } }> }
        finish_reason: string
      }>
    }
    expect(json.choices[0].finish_reason).toBe("tool_calls")
    expect(json.choices[0].message.tool_calls?.[0].function.name).toBe("search_http_history")
  })

  it("tool intent also surfaces in stream mode", async () => {
    const body: ChatBody = {
      model: "gpt-mock-1",
      messages: [{ role: "user", content: "invoke the tool now please" }],
      stream: true,
    }
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    expect(text).toContain('"tool_calls"')
    expect(text).toContain("search_http_history")
  })

  it("POST /v1/responses non-stream works", async () => {
    const res = await fetch(`${base}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-mock-1", input: "hello responses" }),
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { output: Array<{ type: string }> }
    expect(json.output[0].type).toBe("message")
  })
})

describe("provider mock failure modes", () => {
  let handle: ProviderServerHandle
  let base: string

  afterAll(async () => {
    delete process.env.PROVIDER_FAIL
  })

  it("PROVIDER_FAIL=403 surfaces an error", async () => {
    process.env.PROVIDER_FAIL = "403"
    handle = await startProviderServer()
    base = handle.url
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    })
    expect(res.status).toBe(403)
    const json = (await res.json()) as { error: { message: string } }
    expect(json.error.message).toContain("unauthorized")
    await handle.close()
  })

  it("PROVIDER_FAIL=500 surfaces a server error", async () => {
    process.env.PROVIDER_FAIL = "500"
    handle = await startProviderServer()
    base = handle.url
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    })
    expect(res.status).toBe(500)
    await handle.close()
  })

  it("PROVIDER_FAIL=stream_error emits an SSE error chunk", async () => {
    process.env.PROVIDER_FAIL = "stream_error"
    handle = await startProviderServer()
    base = handle.url
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    })
    const text = await res.text()
    expect(text).toContain('"stream_error"')
    await handle.close()
  })
})
