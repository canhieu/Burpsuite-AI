package agent

import agent.http.HttpBridge
import agent.http.HttpJson
import agent.http.RawHttpMessage
import agent.http.RefItem
import agent.rpc.Json
import agent.rpc.RpcFailure
import burp.api.montoya.http.HttpService
import com.google.gson.JsonObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit

class HttpHandlers(private val ctx: AgentContext) : RpcHandler {

    override fun handles(method: String): Boolean = method.startsWith("http.") || method.startsWith("mutate.")

    override fun handle(method: String, params: JsonObject): Any? = when (method) {
        "http.send" -> send(params)
        "http.batch" -> batch(params)
        "http.race" -> race(params)
        "mutate.preview" -> preview(params)
        else -> throw RpcFailure(-32601, "method not found: $method")
    }

    private fun send(params: JsonObject): JsonObject {
        if (ctx.policy.killAll.get()) {
            throw RpcFailure(403, "kill switch engaged", Json.obj("reason" to "kill switch engaged"))
        }
        val via = params.get("via")?.asString ?: "proxy"
        val mutation = params.get("mutate")?.takeIf { it.isJsonObject }?.asJsonObject?.let { Mutation.parseSafe(it) }
        val redacted = params.get("redacted")?.asBoolean ?: true

        var raw: RawHttpMessage
        var service: HttpService?
        val ref = params.get("ref")?.takeIf { it.isJsonObject }?.asJsonObject
        val reqJson = params.get("request")?.takeIf { it.isJsonObject }?.asJsonObject
        val httpServiceJson = params.get("httpService")?.takeIf { it.isJsonObject }?.asJsonObject
        service = httpServiceJson?.let { parseService(it) }

        if (ref != null) {
            val base = ctx.fetchByRef(ref) ?: throw RpcFailure(404, "message not found for ref")
            raw = HttpBridge.raw(base.request)
            if (service == null) service = base.service
        } else if (reqJson != null) {
            raw = HttpJson.fromJson(reqJson)
        } else {
            throw RpcFailure(-32602, "ref or request required")
        }

        raw = ctx.authContexts.applyTo(raw, ctx.authContexts.active())
        val targetUrl = HttpBridge.absoluteUrl(raw, service)
        val method = HttpBridge.methodOf(raw)

        when (val decision = ctx.policy.canSend(targetUrl, method)) {
            is SendDecision.Deny -> throw RpcFailure(403, decision.reason, Json.obj("reason" to decision.reason))
            else -> {}
        }

        if (mutation != null) {
            raw = mutation.apply(raw)
        }
        if (service == null) service = HttpBridge.serviceFor(raw, null)
        if (service == null) throw RpcFailure(-32602, "cannot determine http service (Host header or httpService required)")

        val request = HttpBridge.request(raw, service)
        val start = System.nanoTime()
        val rr = ctx.api.http().sendRequest(request)
        val timingMs = (System.nanoTime() - start) / 1_000_000
        ctx.policy.registerSend()

        val storeId = ctx.messageStore.put(rr)
        runCatching { ctx.api.siteMap().add(rr) }

        val location = rr.response()?.headerValue("Location")
        val baseUrl = rr.request().url()
        when (val rd = ctx.policy.checkRedirect(location, baseUrl)) {
            is RedirectDecision.Blocked -> throw RpcFailure(
                403, rd.reason,
                Json.obj("reason" to rd.reason, "target" to rd.target)
            )
            else -> {}
        }

        val respRaw = rr.response()?.let { HttpBridge.raw(it) }
        val respJson = respRaw?.let { HttpJson.toJson(it, redacted) }
        val statusCode = rr.response()?.statusCode()
        ctx.logRpc("http.send", targetUrl, statusCode?.toString() ?: "no-response")
        return Json.obj(
            "ref" to HttpJson.messageRef(ctx.projectId, "agent", storeId),
            "statusCode" to statusCode,
            "responseStartLine" to respJson?.get("startLine")?.asString,
            "headers" to respJson?.get("headers"),
            "body" to respJson?.get("body")?.asString,
            "bodyTruncated" to respJson?.get("bodyTruncated")?.asBoolean,
            "bodyOffset" to respJson?.get("bodyOffset")?.takeIf { !it.isJsonNull }?.asInt,
            "timingMs" to timingMs,
            "via" to via,
        )
    }

    private fun batch(params: JsonObject): JsonObject {
        val requests = params.get("requests")?.takeIf { it.isJsonArray }?.asJsonArray
            ?: throw RpcFailure(-32602, "requests required")
        val concurrency = (params.get("concurrency")?.asInt ?: 5).coerceIn(1, 32)
        val ratePerSecond = params.get("ratePerSecond")?.asInt?.takeIf { it > 0 }

        val pool = Executors.newFixedThreadPool(concurrency) { r -> Thread(r, "agent-http-batch").apply { isDaemon = true } }
        try {
            val futures = ArrayList<Future<JsonObject>>()
            for (el in requests) {
                val item = el.asJsonObject
                futures.add(pool.submit(java.util.concurrent.Callable { runCatchingRpc { send(item) } }))
                if (ratePerSecond != null) {
                    Thread.sleep((1000L / ratePerSecond))
                }
            }
            val results = futures.map { f ->
                try {
                    f.get(120, TimeUnit.SECONDS)
                } catch (e: Exception) {
                    Json.obj("error" to (e.message ?: "batch item error"))
                }
            }
            return Json.obj("results" to results)
        } finally {
            pool.shutdownNow()
        }
    }

    private fun race(params: JsonObject): JsonObject {
        val base = params.get("base")?.takeIf { it.isJsonObject }?.asJsonObject
            ?: throw RpcFailure(-32602, "base required")
        val count = params.get("count")?.asInt ?: throw RpcFailure(-32602, "count required")
        val startLatch = CountDownLatch(1)
        val results = java.util.concurrent.ConcurrentLinkedQueue<JsonObject>()
        val threads = (0 until count).map { _ ->
            Thread {
                try {
                    startLatch.await()
                    results.add(runCatchingRpc { send(base) })
                } catch (e: InterruptedException) {
                    Thread.currentThread().interrupt()
                }
            }.apply { isDaemon = true }
        }
        threads.forEach { it.start() }
        startLatch.countDown()
        threads.forEach { it.join() }
        val list = results.toList()
        val distinct = list
            .mapNotNull { r ->
                val code = r.get("statusCode")?.takeIf { !it.isJsonNull }?.asInt
                val body = r.get("body")?.takeIf { !it.isJsonNull }?.asString
                if (code != null) code to body?.hashCode() else null
            }
            .toSet()
            .size
        return Json.obj("results" to list, "distinctResponses" to distinct)
    }

    private fun preview(params: JsonObject): JsonObject {
        val mutation = params.get("mutation")?.takeIf { it.isJsonObject }?.asJsonObject?.let { Mutation.parseSafe(it) }
            ?: throw RpcFailure(-32602, "mutation required")
        var raw: RawHttpMessage
        var service: HttpService? = null
        val ref = params.get("ref")?.takeIf { it.isJsonObject }?.asJsonObject
        val reqJson = params.get("request")?.takeIf { it.isJsonObject }?.asJsonObject
        if (ref != null) {
            val base = ctx.fetchByRef(ref) ?: throw RpcFailure(404, "message not found for ref")
            raw = HttpBridge.raw(base.request)
            service = base.service
        } else if (reqJson != null) {
            raw = HttpJson.fromJson(reqJson)
        } else {
            throw RpcFailure(-32602, "ref or request required")
        }
        raw = ctx.authContexts.applyTo(raw, ctx.authContexts.active())
        val mutated = mutation.apply(raw)
        val url = HttpBridge.absoluteUrl(mutated, service)
        ctx.logRpc("mutate.preview", url, "ok")
        return Json.obj("request" to HttpJson.toJson(mutated))
    }

    private fun fetchByRef(ref: JsonObject): RefItem? = ctx.fetchByRef(ref)

    private fun parseService(o: JsonObject): HttpService {
        val host = o.get("host")?.asString ?: throw RpcFailure(-32602, "httpService.host required")
        val port = o.get("port")?.asInt ?: 80
        val secure = o.get("secure")?.asBoolean ?: (port == 443)
        return HttpService.httpService(host, port, secure)
    }

    private fun runCatchingRpc(block: () -> JsonObject): JsonObject {
        return try {
            block()
        } catch (e: RpcFailure) {
            Json.obj("error" to e.message, "code" to e.code, "reason" to e.data?.asJsonObject?.get("reason")?.asString)
        } catch (e: Exception) {
            Json.obj("error" to (e.message ?: "error"))
        }
    }
}
