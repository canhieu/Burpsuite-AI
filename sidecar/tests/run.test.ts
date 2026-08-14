import { describe, it, expect } from "vitest"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import type { ChatMessage, ProviderEvent } from "../src/providers.js"
import { AgentEngine } from "../src/agent/orchestrator.js"
import type { ModelClient } from "../src/agent/executor.js"
import type { ToolBridge } from "../src/agent/rpc-bridge.js"
import type { BridgeResult } from "../src/agent/rpc-bridge.js"
import { makeConfig, connectClient, sendRequest, type TestClient } from "./helper.js"
import { createStore } from "../src/store.js"
import { createProviderRegistry, type ProviderRegistry } from "../src/providers.js"
import { RpcServer } from "../src/rpc.js"
import { createLogger } from "../src/util.js"
import type { Handler, Services } from "../src/handlers/types.js"
import { lifecycleHandlers } from "../src/handlers/lifecycle.js"
import { findingHandlers } from "../src/handlers/findings.js"
import { payloadHandlers } from "../src/handlers/payloads.js"
import { registerRunHandlers } from "../src/handlers/run-handler.js"

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function textModel(output: string): ModelClient {
  return {
    async *stream() {
      yield { type: "text", data: output } as ProviderEvent
      yield { type: "done", data: {} } as ProviderEvent
    },
  }
}

function executorModel(script: (messages: ChatMessage[]) => ProviderEvent[]): ModelClient {
  return {
    async *stream(messages) {
      for (const ev of script(messages)) yield ev
    },
  }
}

function hasToolResult(messages: ChatMessage[]): boolean {
  return messages.some((m) => typeof m.content === "string" && m.content.includes("<tool_result>"))
}

class FakeBridge implements ToolBridge {
  calls: Array<{ method: string; params: Record<string, unknown> }> = []
  handlers: Record<string, (params: Record<string, unknown>, signal?: AbortSignal) => Promise<BridgeResult>> = {}

  async request(method: string, params: Record<string, unknown>, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<BridgeResult> {
    this.calls.push({ method, params })
    const fn = this.handlers[method]
    if (!fn) return { ok: true, result: { statusCode: 200 } }
    return fn(params, opts?.signal)
  }

  callCount(method: string): number {
    return this.calls.filter((c) => c.method === method).length
  }

  waitForCalls(count: number, method?: string): Promise<void> {
    const check = () => this.calls.filter((c) => !method || c.method === method).length >= count
    if (check()) return Promise.resolve()
    return new Promise((resolve) => {
      const iv = setInterval(() => {
        if (check()) {
          clearInterval(iv)
          resolve()
        }
      }, 5)
    })
  }
}

interface EventEntry {
  method: string
  params: Record<string, unknown>
}

function eventCollector() {
  const events: EventEntry[] = []
  return {
    events,
    emit: (method: string, params: Record<string, unknown>) => {
      events.push({ method, params })
    },
  }
}

function waitForEvent(events: EventEntry[], method: string, timeoutMs = 4000): Promise<EventEntry> {  return new Promise((resolve, reject) => {
    const hit = events.find((e) => e.method === method)
    if (hit) return resolve(hit)
    const start = Date.now()
    const iv = setInterval(() => {
      const e = events.find((x) => x.method === method)
      if (e) {
        clearInterval(iv)
        resolve(e)
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(iv)
        reject(new Error(`timeout waiting for event ${method}`))
      }
    }, 5)
  })
}

async function rpcCall(c: TestClient, id: number | string, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
  sendRequest(c.ws, id, method, params)
  for (;;) {
    const msg = (await c.next()) as Record<string, unknown>
    if ((("result" in msg) || ("error" in msg)) && msg["id"] === id) return msg
  }
}

async function waitUntilStatus(c: TestClient, id: number | string, runId: string, terminal: string[]): Promise<{ status: string; requestsUsed: number }> {
  for (let i = 0; i < 100; i++) {
    const res = await rpcCall(c, id, "agent.run.status", { runId })
    const st = res["result"] as { status: string; requestsUsed: number }
    if (terminal.includes(st.status)) return st
    await delay(20)
  }
  throw new Error("status never reached terminal state")
}

function makeEngine(  overrides: {
    planner?: ModelClient
    executor?: ModelClient
    bridge?: ToolBridge
  } = {},
) {
  const collector = eventCollector()
  const planner = overrides.planner ?? textModel(JSON.stringify([{ endpoint: "https://a.example/", skill: "", hypothesis: "test" }]))
  const executor = overrides.executor ?? executorModel(() => [{ type: "text", data: JSON.stringify({ conclusion: "no issue" }) }])
  const bridge = overrides.bridge ?? new FakeBridge()
  const engine = new AgentEngine({
    emit: collector.emit,
    bridge,
    models: { planner, executor },
    log: () => {},
  })
  return { engine, collector, bridge }
}

describe("run engine", () => {
  it("orchestrator produces a plan from a mocked planner", async () => {
    const planner = textModel(
      JSON.stringify([
        { endpoint: "https://a.example/login", skill: "sqli", hypothesis: "test login injection" },
        { endpoint: "https://a.example/search", skill: "xss", hypothesis: "test reflected xss" },
      ]),
    )
    const { engine } = makeEngine({ planner })
    const runId = await engine.start({ task: "test the app", mode: "autonomous" })
    const status = await engine.waitFor(runId)
    expect(status.status).toBe("completed")
    expect(status.plan).toHaveLength(2)
    expect(status.plan![0]).toContain("https://a.example/login")
    expect(status.plan![1]).toContain("search")
  })

  it("executors run a fake tool loop, budget decrements, run completes with a finding", async () => {
    const executor = executorModel((messages) => {
      if (hasToolResult(messages)) {
        return [
          {
            type: "text",
            data: JSON.stringify({
              conclusion: "found an issue",
              finding: { title: "SQLi login", vulnClass: "sqli", severity: "high", confidence: "medium" },
            }),
          },
        ]
      }
      return [{ type: "text", data: JSON.stringify({ tool_call: { name: "http.send", arguments: { ref: { projectId: "p", source: "proxy", id: 1 } } } }) }]
    })
    const bridge = new FakeBridge()
    const collector = eventCollector()
    const engine = new AgentEngine({ emit: collector.emit, bridge, models: { planner: textModel(JSON.stringify([{ endpoint: "https://a.example/login", skill: "", hypothesis: "test" }])), executor }, log: () => {} })
    const runId = await engine.start({ task: "test", mode: "autonomous", executors: 1, budget: { requests: 10 } })
    const status = await engine.waitFor(runId)
    expect(status.status).toBe("completed")
    expect(status.requestsUsed).toBe(1)
    expect(bridge.callCount("http.send")).toBe(1)
    const findings = engine.findings(runId)
    expect(findings).toHaveLength(1)
    expect(findings[0].title).toBe("SQLi login")
  })

  it("approval-required tool blocks executor until agent.approve(true) then proceeds", async () => {
    const executor = executorModel((messages) => {
      if (hasToolResult(messages)) {
        return [{ type: "text", data: JSON.stringify({ conclusion: "done" }) }]
      }
      return [{ type: "text", data: JSON.stringify({ tool_call: { name: "http.send", arguments: {} } }) }]
    })
    const bridge = new FakeBridge()
    const collector = eventCollector()
    const engine = new AgentEngine({ emit: collector.emit, bridge, models: { planner: textModel(JSON.stringify([{ endpoint: "https://a.example/", skill: "", hypothesis: "test" }])), executor }, log: () => {} })
    const runId = await engine.start({ task: "test", mode: "manual", executors: 1 })

    const approval = await waitForEvent(collector.events, "approval.requested")
    const request = approval.params["request"] as { id: string; reason: string }
    expect(request.id).toBeTruthy()
    expect(request.reason).toContain("http.send")
    expect(bridge.callCount("http.send")).toBe(0)

    const res = engine.approve(request.id, true)
    expect(res.ok).toBe(true)

    const status = await engine.waitFor(runId)
    expect(status.status).toBe("completed")
    expect(bridge.callCount("http.send")).toBe(1)
  })

  it("approval deny records denied result and model adapts", async () => {
    const executor = executorModel((messages) => {
      if (hasToolResult(messages)) {
        return [{ type: "text", data: JSON.stringify({ conclusion: "adapted after denial" }) }]
      }
      return [{ type: "text", data: JSON.stringify({ tool_call: { name: "http.send", arguments: {} } }) }]
    })
    const bridge = new FakeBridge()
    const collector = eventCollector()
    const engine = new AgentEngine({ emit: collector.emit, bridge, models: { planner: textModel(JSON.stringify([{ endpoint: "https://a.example/", skill: "", hypothesis: "test" }])), executor }, log: () => {} })
    const runId = await engine.start({ task: "test", mode: "manual", executors: 1 })

    const approval = await waitForEvent(collector.events, "approval.requested")
    const request = approval.params["request"] as { id: string }
    expect(engine.approve(request.id, false).ok).toBe(true)

    const status = await engine.waitFor(runId)
    expect(status.status).toBe("completed")
    expect(bridge.callCount("http.send")).toBe(0)
  })

  it("kill cancels immediately", async () => {
    const executor = executorModel(() => [{ type: "text", data: JSON.stringify({ tool_call: { name: "http.send", arguments: {} } }) }])
    const bridge = new FakeBridge()
    bridge.handlers["http.send"] = () => new Promise<BridgeResult>(() => {})
    const collector = eventCollector()
    const engine = new AgentEngine({ emit: collector.emit, bridge, models: { planner: textModel(JSON.stringify([{ endpoint: "https://a.example/", skill: "", hypothesis: "test" }])), executor }, log: () => {} })
    const runId = await engine.start({ task: "test", mode: "autonomous", executors: 1 })

    await bridge.waitForCalls(1, "http.send")
    engine.kill()

    const status = engine.status(runId)
    expect(status?.status).toBe("cancelled")
    expect(bridge.callCount("http.send")).toBe(1)
  })

  it("budget exhaustion stops executor and emits budget.warning", async () => {
    const executor = executorModel(() => [{ type: "text", data: JSON.stringify({ tool_call: { name: "http.send", arguments: {} } }) }])
    const bridge = new FakeBridge()
    const collector = eventCollector()
    const engine = new AgentEngine({ emit: collector.emit, bridge, models: { planner: textModel(JSON.stringify([{ endpoint: "https://a.example/", skill: "", hypothesis: "test" }])), executor }, log: () => {} })
    const runId = await engine.start({ task: "test", mode: "autonomous", executors: 1, budget: { requests: 5 } })
    const status = await engine.waitFor(runId)
    expect(status.status).toBe("completed")
    expect(bridge.callCount("http.send")).toBe(4)
    const warnings = collector.events.filter((e) => e.method === "budget.warning")
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings[0].params).toMatchObject({ runId, metric: "requests" })
  })

  it("pause stops new tool calls and resume continues", async () => {
    const executor = executorModel(() => [{ type: "text", data: JSON.stringify({ tool_call: { name: "http.send", arguments: {} } }) }])
    const bridge = new FakeBridge()
    bridge.handlers["http.send"] = async () => {
      await delay(40)
      return { ok: true, result: { statusCode: 200 } }
    }
    const collector = eventCollector()
    const engine = new AgentEngine({ emit: collector.emit, bridge, models: { planner: textModel(JSON.stringify([{ endpoint: "https://a.example/", skill: "", hypothesis: "test" }])), executor }, log: () => {} })
    const runId = await engine.start({ task: "test", mode: "autonomous", executors: 1, budget: { requests: 4 } })

    await bridge.waitForCalls(1, "http.send")
    engine.pause(runId)
    await delay(60)
    expect(bridge.callCount("http.send")).toBe(1)
    expect(engine.status(runId)?.status).toBe("paused")

    engine.resume(runId)
    const status = await engine.waitFor(runId)
    expect(status.status).toBe("completed")
    expect(bridge.callCount("http.send")).toBe(3)
  })
})

describe("run handlers over WebSocket", () => {
  async function bootServer(planner: ModelClient, executor: ModelClient, bridge: ToolBridge) {
    const config = makeConfig()
    const store = await createStore(config.dataDir)
    const registry: ProviderRegistry = await createProviderRegistry(config)
    const services: Services = {
      config,
      store,
      registry,
      startTime: Date.now(),
      sidecarVersion: "0.1.0",
      log: () => {},
      getProviderStatuses: async () => [],
    }
    const handlers = new Map<string, Handler>()
    for (const group of [lifecycleHandlers(), findingHandlers(), payloadHandlers()]) {
      for (const [m, h] of Object.entries(group)) handlers.set(m, h)
    }
    const logger = createLogger("error", "test")
    const server = createServer()
    const rpc = new RpcServer(config, services, logger, handlers, "0.1.0")
    const { group: runGroup } = registerRunHandlers(rpc, { services, handlers, models: { planner, executor }, bridge })
    for (const [m, h] of Object.entries(runGroup)) handlers.set(m, h)
    rpc.attach(server)
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
    const port = (server.address() as AddressInfo).port
    return {
      url: `ws://127.0.0.1:${port}`,
      store,
      rpc,
      server,
      close: async () => {
        rpc.close()
        store.close()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      },
    }
  }

  it("agent.run.start returns runId and agent.run.status reports completion", async () => {
    const planner = textModel(JSON.stringify([{ endpoint: "https://a.example/", skill: "", hypothesis: "test" }]))
    const executor = executorModel(() => [{ type: "text", data: JSON.stringify({ conclusion: "ok" }) }])
    const bridge = new FakeBridge()
    const s = await bootServer(planner, executor, bridge)

    const c = await connectClient(s.url)
    c.ws.send(JSON.stringify({ jsonrpc: "2.0", method: "handshake.hello", params: { projectId: "p", nonce: "n", token: "test-token" } }))
    const hello = (await c.next()) as Record<string, unknown>
    expect(hello["method"]).toBe("agent.hello")

    const startRes = await rpcCall(c, 1, "agent.run.start", { task: "test the app", mode: "autonomous" })
    expect(startRes["id"]).toBe(1)
    const runId = (startRes["result"] as { runId: string }).runId
    expect(typeof runId).toBe("string")

    const final = await waitUntilStatus(c, 3, runId, ["completed", "error", "cancelled"])
    expect(final.status).toBe("completed")
    expect(final.requestsUsed).toBe(0)

    const notFound = await rpcCall(c, 4, "agent.run.status", { runId: "missing" })
    expect(notFound["error"]).toMatchObject({ code: 404 })

    await c.close()
    await s.close()
  })

  it("agent.approve routes to the pending approval request", async () => {
    const planner = textModel(JSON.stringify([{ endpoint: "https://a.example/", skill: "", hypothesis: "test" }]))
    const executor = executorModel((messages) => {
      if (hasToolResult(messages)) {
        return [{ type: "text", data: JSON.stringify({ conclusion: "done" }) }]
      }
      return [{ type: "text", data: JSON.stringify({ tool_call: { name: "http.send", arguments: {} } }) }]
    })
    const bridge = new FakeBridge()
    const s = await bootServer(planner, executor, bridge)

    const c = await connectClient(s.url)
    c.ws.send(JSON.stringify({ jsonrpc: "2.0", method: "handshake.hello", params: { projectId: "p", nonce: "n", token: "test-token" } }))
    await c.next()

    const startRes = await rpcCall(c, 1, "agent.run.start", { task: "test", mode: "manual", executors: 1 })
    const runId = (startRes["result"] as { runId: string }).runId

    let approvalEvent: Record<string, unknown> | undefined
    for (let i = 0; i < 100; i++) {
      const msg = (await c.next()) as Record<string, unknown>
      if (msg["method"] === "approval.requested") {
        approvalEvent = msg
        break
      }
    }
    expect(approvalEvent).toBeTruthy()
    const request = (approvalEvent!["params"] as { request: { id: string } }).request

    const approveRes = await rpcCall(c, 2, "agent.approve", { requestId: request.id, approved: true })
    expect(approveRes["result"]).toMatchObject({ ok: true })

    await waitUntilStatus(c, 3, runId, ["completed", "error", "cancelled"])
    expect(bridge.callCount("http.send")).toBe(1)

    await c.close()
    await s.close()
  })
})
