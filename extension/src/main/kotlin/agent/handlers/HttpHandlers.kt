package agent

import agent.http.HttpBridge
import agent.http.HttpJson
import agent.http.RawHttpMessage
import agent.http.RefItem
import agent.rpc.Json
import agent.rpc.RpcFailure
import burp.api.montoya.http.HttpService
import burp.api.montoya.http.message.HttpRequestResponse
import burp.api.montoya.http.message.responses.HttpResponse
import com.google.gson.JsonObject
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

class HttpHandlers(private val ctx: AgentContext) : RpcHandler {

    override fun handles(method: String): Boolean = method.startsWith("http.") || method.startsWith("mutate.")

    override fun handle(method: String, params: JsonObject): Any? = when (method) {
        "http.send" -> send(params)
        "http.batch" -> batch(params)
        "http.race" -> race(params)
        "mutate.preview" -> preview(params)
        else -> throw RpcFailure(-32601, "method not found: $method")
    }

    private fun proxyRelayTarget(): Pair<String, Int> = Pair("127.0.0.1", 8080)

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
        val rr = if (via == "proxy") {
            sendViaProxy(raw, service)
        } else {
            ctx.api.http().sendRequest(request)
        }
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

    /**
     * Relay a request through the Burp proxy listener so it lands in HTTP History
     * (Montoya's sendRequest bypasses the proxy and never hits history).
     * HTTPS: CONNECT tunnel + TLS with a trust-all socket manager (Burp MITM).
     */
    private fun sendViaProxy(raw: RawHttpMessage, service: HttpService): HttpRequestResponse {
        val (ph, pp) = proxyRelayTarget()
        val startLine = raw.startLine.trim()
        val method = startLine.substringBefore(' ')
        val path = startLine.substringAfter(' ', "").substringBefore(' ')
        val host = service.host()
        val port = service.port()
        val secure = service.secure()

        val connectHost = if (secure) "$host:$port" else host
        val connectLine = if (secure) "CONNECT $connectHost HTTP/1.1\r\nHost: $connectHost\r\n\r\n".toByteArray() else null
        val target = if (path.startsWith("http://") || path.startsWith("https://")) path else path
        val scheme = if (secure) "https" else "http"
        val authority = when {
            secure && port == 443 -> host
            secure -> "$host:$port"
            !secure && port == 80 -> host
            else -> "$host:$port"
        }
        val requestLine = if (secure) {
            // after CONNECT tunnel: origin-form to the origin server (Burp MITM forwards it)
            "$method $target HTTP/1.1"
        } else {
            // no tunnel: absolute-form so the proxy routes the request
            "$method ${if (target.startsWith("http")) target else "$scheme://$authority$target"} HTTP/1.1"
        }

        val body = raw.body
        val headerBytes = run {
            val text = buildString {
                append(requestLine).append("\r\n")
                for (h in raw.headers) {
                    if (h.name.equals("Content-Length", true)) continue
                    append(h.name).append(": ").append(h.value).append("\r\n")
                }
                append("Content-Length: ").append(body.size).append("\r\n")
                append("Connection: close\r\n\r\n")
            }
            text.toByteArray(Charsets.ISO_8859_1)
        }

        val socket = Socket()
        socket.connect(InetSocketAddress(ph, pp), 15000)
        socket.soTimeout = 60000
        val out: OutputStream = socket.getOutputStream()
        if (connectLine != null) {
            out.write(connectLine)
            out.flush()
            val in0 = DataInputStream(socket.getInputStream())
            val connectResp = readUntilHeaders(in0)
            val status = connectResp.trim().lineSequence().firstOrNull() ?: ""
            if (!status.contains("200")) {
                socket.close()
                throw RpcFailure(502, "proxy CONNECT failed: $status")
            }
        }
        out.write(headerBytes)
        out.write(body)
        out.flush()

        val sslSocket: Socket = if (secure) {
            val ctx = SSLContext.getInstance("TLS")
            ctx.init(null, arrayOf<TrustManager>(TRUST_ALL), SecureRandom())
            val s = ctx.socketFactory.createSocket(socket, host, port, true) as SSLSocket
            s.soTimeout = 60000
            s.startHandshake()
            s
        } else {
            socket
        }

        val respBytes = try {
            readResponse(DataInputStream(sslSocket.getInputStream()))
        } finally {
            runCatching { sslSocket.close() }
            runCatching { socket.close() }
        }
        return HttpRequestResponse.httpRequestResponse(
            HttpBridge.request(raw, service),
            HttpResponse.httpResponse(burp.api.montoya.core.ByteArray.byteArray(*respBytes)),
        )
    }

    private fun readUntilHeaders(input: DataInputStream): String {
        val buf = StringBuilder()
        val chunk = ByteArray(4096)
        while (buf.length < 64 * 1024) {
            val n = input.read(chunk)
            if (n < 0) break
            buf.append(String(chunk, 0, n, Charsets.ISO_8859_1))
            if (buf.contains("\r\n\r\n")) break
        }
        return buf.toString()
    }

    private fun decodeChunked(data: ByteArray): ByteArray {
        val out = ByteArrayOutputStream()
        var i = 0
        while (i < data.size) {
            var j = i
            while (j < data.size && data[j] != '\r'.code.toByte()) j++
            if (j >= data.size) break
            val lineEnd = j
            val sizeHex = String(data, i, lineEnd - i, Charsets.ISO_8859_1).trim().substringBefore(';')
            val size = sizeHex.toIntOrNull(16) ?: break
            if (size == 0) break
            val start = lineEnd + 2
            if (start + size > data.size) break
            out.write(data, start, size)
            i = start + size + 2
        }
        return out.toByteArray()
    }

    private fun readResponse(input: DataInputStream): ByteArray {
        val head = readUntilHeaders(input)
        val headBytes = head.toByteArray(Charsets.ISO_8859_1)
        val headerBlock = head.substringBefore("\r\n\r\n")
        val bodyStart = head.indexOf("\r\n\r\n") + 4
        val out = ByteArrayOutputStream()
        out.write(headBytes)
        val contentLength = headerBlock.lines()
            .firstOrNull { it.lowercase().startsWith("content-length:") }
            ?.substringAfter(":")
            ?.trim()
            ?.toIntOrNull()
        val chunked = headerBlock.lines().any { it.lowercase().startsWith("transfer-encoding:") && it.lowercase().contains("chunked") }
        if (chunked) {
            // decode chunked body; rewrite headers to fixed Content-Length
            val headEnd = head.indexOf("\r\n\r\n") + 4
            val pending = headBytes.copyOfRange(headEnd, headBytes.size)
            out.write(headBytes, 0, headEnd)
            val bodyOut = ByteArrayOutputStream()
            bodyOut.write(pending)
            // drain rest from socket, decode chunks
            val rest = ByteArrayOutputStream()
            val buf = ByteArray(16384)
            while (true) {
                val n = try { input.read(buf) } catch (_: java.net.SocketTimeoutException) { break }
                if (n < 0) break
                rest.write(buf, 0, n)
            }
            bodyOut.write(rest.toByteArray())
            val decoded = decodeChunked(bodyOut.toByteArray())
            // emit as content-length style body (headers still say chunked; acceptable for history display)
            out.write(decoded)
        } else if (contentLength != null) {
            val total = contentLength + 4
            var remaining = contentLength
            if (bodyStart < headBytes.size && headBytes.size > bodyStart) {
                remaining -= (headBytes.size - bodyStart)
                out.write(headBytes, bodyStart, headBytes.size - bodyStart)
            }
            val buf = ByteArray(8192)
            while (remaining > 0) {
                val n = input.read(buf)
                if (n < 0) break
                val take = minOf(n, remaining)
                out.write(buf, 0, take)
                remaining -= take
            }
        } else {
            // no body declared; read to close
            val buf = ByteArray(16384)
            while (true) {
                val n = try { input.read(buf) } catch (_: java.net.SocketTimeoutException) { break }
                if (n < 0) break
                out.write(buf, 0, n)
            }
        }
        return out.toByteArray()
    }

    companion object {
        private val TRUST_ALL: TrustManager = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {}
            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {}
            override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
        }
    }
}
