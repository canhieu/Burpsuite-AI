package agent

import agent.http.HttpBridge
import agent.http.HttpJson
import agent.http.RefItem
import agent.rpc.Json
import agent.rpc.RpcFailure
import com.google.gson.JsonObject

class HistoryHandlers(private val ctx: AgentContext) : RpcHandler {

    override fun handles(method: String): Boolean = method.startsWith("history.") || method == "logger.read"

    override fun handle(method: String, params: JsonObject): Any? = when (method) {
        "history.search" -> search(params)
        "history.get" -> get(params)
        "history.inventory" -> inventory(params)
        "history.websockets" -> websockets(params)
        "logger.read" -> loggerRead(params)
        else -> throw RpcFailure(-32601, "method not found: $method")
    }

    private fun search(params: JsonObject): JsonObject {
        val host = params.get("host")?.asString?.lowercase()
        val path = params.get("path")?.asString
        val method = params.get("method")?.asString?.uppercase()
        val status = params.get("status")?.asInt
        val mime = params.get("mime")?.asString
        val inScopeOnly = params.get("inScopeOnly")?.asBoolean ?: false
        val since = params.get("since")?.asLong
        val text = params.get("text")?.asString?.lowercase()
        val limit = params.get("limit")?.asInt ?: 200
        val offset = params.get("offset")?.asInt ?: 0

        val api = ctx.api
        val items = ArrayList<JsonObject>()
        for (p in api.proxy().history()) {
            if (items.size >= offset + limit) break
            val pHost = p.host().lowercase()
            val pMethod = p.method().uppercase()
            val pPath = p.path()
            val pStatus = p.response()?.statusCode()
            if (host != null && !pHost.contains(host)) continue
            if (path != null && !pPath.contains(path)) continue
            if (method != null && pMethod != method) continue
            if (status != null && pStatus?.toInt() != status) continue
            if (mime != null && !p.mimeType().name.contains(mime, ignoreCase = true)) continue
            if (inScopeOnly && !api.scope().isInScope(p.url())) continue
            val ts = p.time().toInstant().toEpochMilli()
            if (since != null && ts < since) continue
            if (text != null) {
                val haystack = (p.request().toString() + (p.response()?.toString() ?: "")).lowercase()
                if (!haystack.contains(text)) continue
            }
            val size = p.response()?.body()?.length() ?: 0
            items.add(
                Json.obj(
                    "ref" to HttpJson.messageRef(ctx.projectId, "proxy", p.id()),
                    "method" to pMethod,
                    "host" to pHost,
                    "path" to pPath,
                    "status" to pStatus,
                    "mime" to p.mimeType().name,
                    "contentType" to p.request().contentType()?.name,
                    "timestamp" to ts,
                    "size" to size,
                )
            )
        }
        return Json.obj("items" to items.drop(offset).take(limit))
    }

    private fun get(params: JsonObject): JsonObject {
        val ref = params.get("ref")?.takeIf { it.isJsonObject }?.asJsonObject
            ?: throw RpcFailure(-32602, "ref required")
        val redacted = params.get("redacted")?.asBoolean ?: true
        val item = ctx.fetchByRef(ref) ?: throw RpcFailure(404, "message not found for ref")
        val reqRaw = HttpBridge.raw(item.request)
        val respRaw = item.response?.let { HttpBridge.raw(it) }
        return Json.obj(
            "request" to HttpJson.toJson(reqRaw, redacted),
            "response" to respRaw?.let { HttpJson.toJson(it, redacted) },
            "annotations" to Json.obj(),
            "timing" to Json.obj(),
        )
    }

    private fun inventory(params: JsonObject): JsonObject {
        val host = params.get("host")?.asString?.lowercase()
        val inScopeOnly = params.get("inScopeOnly")?.asBoolean ?: false
        val api = ctx.api
        val groups = LinkedHashMap<EndpointKey, EndpointAgg>()
        for (p in api.proxy().history()) {
            if (host != null && !p.host().lowercase().contains(host)) continue
            if (inScopeOnly && !api.scope().isInScope(p.url())) continue
            val key = EndpointKey(p.host().lowercase(), p.method().uppercase(), routeShape(p.path()))
            val agg = groups.getOrPut(key) { EndpointAgg() }
            agg.count++
            p.response()?.statusCode()?.let { agg.statuses.add(it.toString()) }
            agg.mimes.add(p.mimeType().name)
            collectParams(p.request(), agg.params)
        }
        val endpoints = groups.entries
            .sortedByDescending { it.value.count }
            .take(1000)
            .map { (key, agg) ->
                Json.obj(
                    "method" to key.method,
                    "host" to key.host,
                    "routeShape" to key.route,
                    "params" to agg.params.toList().sorted(),
                    "statuses" to agg.statuses.toList().sorted(),
                    "mime" to agg.mimes.toList().sorted(),
                    "count" to agg.count,
                    "authContexts" to emptyList<Any>(),
                )
            }
        return Json.obj("endpoints" to endpoints)
    }

    private fun websockets(params: JsonObject): JsonObject {
        val host = params.get("host")?.asString?.lowercase()
        val byId = LinkedHashMap<Int, MutableList<JsonObject>>()
        for (m in ctx.api.proxy().webSocketHistory()) {
            val upg = m.upgradeRequest()
            if (host != null) {
                val wsHost = upg.httpService()?.host()?.lowercase()
                val inHost = wsHost?.contains(host) == true
                val inRaw = upg.toString().contains(host, ignoreCase = true)
                if (!inHost && !inRaw) continue
            }
            val list = byId.getOrPut(m.webSocketId()) { ArrayList() }
            val payload = m.payload()
            val text = payload.toString().let { t -> if (isUtf8Readable(payload.getBytes())) t else null }
            list.add(
                Json.obj(
                    "direction" to m.direction().name,
                    "text" to text,
                    "base64" to if (text == null) Base64Util.encode(payload.getBytes()) else null,
                    "time" to m.time().toInstant().toEpochMilli(),
                )
            )
        }
        val connections = byId.map { (id, messages) ->
            val url = ctx.api.proxy().webSocketHistory().firstOrNull { it.webSocketId() == id }?.upgradeRequest()?.url()
            Json.obj("wsId" to id, "url" to url, "messages" to messages)
        }
        return Json.obj("connections" to connections)
    }

    private fun loggerRead(params: JsonObject): JsonObject {
        val since = params.get("since")?.asLong
        val host = params.get("host")?.asString
        val entries = ctx.audit.recent(since, host).map { e ->
            Json.obj(
                "time" to e.time,
                "level" to e.level,
                "method" to e.method,
                "target" to e.target,
                "status" to e.status,
                "note" to e.note,
            )
        }
        return Json.obj("entries" to entries)
    }

    private fun fetchByRef(ref: JsonObject): RefItem? = ctx.fetchByRef(ref)

    private data class EndpointKey(val host: String, val method: String, val route: String)
    private class EndpointAgg {
        var count = 0
        val statuses = LinkedHashSet<String>()
        val mimes = LinkedHashSet<String>()
        val params = LinkedHashSet<String>()
    }

    private fun routeShape(path: String): String {
        val parts = path.split('/').map { seg ->
            if (seg.any { it.isDigit() }) "{n}" else seg
        }
        return parts.joinToString("/")
    }

    private fun collectParams(request: burp.api.montoya.http.message.requests.HttpRequest, out: LinkedHashSet<String>) {
        try {
            request.parameters().forEach { out.add(it.name()) }
        } catch (e: Exception) {
        }
    }

    private fun isUtf8Readable(bytes: ByteArray): Boolean {
        if (bytes.isEmpty()) return true
        if (bytes.any { it.toInt() == 0 }) return false
        return try {
            val s = String(bytes, Charsets.UTF_8)
            s.toByteArray(Charsets.UTF_8).contentEquals(bytes) && s.all { it != '\uFFFD' }
        } catch (e: Exception) {
            false
        }
    }
}
