package agent.rpc

import com.google.gson.Gson
import com.google.gson.GsonBuilder
import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.google.gson.JsonParser

const val JSON_RPC_VERSION = "2.0"

class RpcError(
    val code: Int,
    val message: String,
    val data: JsonElement? = null,
) {
    fun toJson(): JsonObject {
        val o = JsonObject()
        o.addProperty("code", code)
        o.addProperty("message", message)
        if (data != null) o.add("data", data)
        return o
    }
}

data class SidecarReply(
    val result: JsonElement?,
    val error: RpcError?,
) {
    fun require(): JsonElement {
        error?.let { throw RpcFailure(it.code, it.message, it.data) }
        return result ?: JsonNull.INSTANCE
    }
}

class RpcFailure(
    val code: Int,
    override val message: String,
    val data: JsonElement? = null,
) : Exception(message)

sealed class RpcIncoming {
    class Request(val id: Any, val method: String, val params: JsonObject) : RpcIncoming()
    class Notification(val method: String, val params: JsonObject) : RpcIncoming()
    class Response(val id: Any, val result: JsonElement?, val error: RpcError?) : RpcIncoming()
}

object Json {

    val gson: Gson = GsonBuilder().disableHtmlEscaping().create()

    fun toTree(any: Any?): JsonElement = when (any) {
        null -> JsonNull.INSTANCE
        is JsonElement -> any
        else -> gson.toJsonTree(any)
    }

    fun obj(vararg pairs: Pair<String, Any?>): JsonObject {
        val o = JsonObject()
        for ((k, v) in pairs) {
            if (v == null) {
                o.add(k, JsonNull.INSTANCE)
            } else {
                o.add(k, toTree(v))
            }
        }
        return o
    }

    fun obj(): JsonObject = JsonObject()

    fun str(o: JsonObject, key: String, value: Any?) {
        o.add(key, toTree(value))
    }
}

object RpcMessage {

    fun parse(text: String): RpcIncoming? {
        val el = try {
            JsonParser.parseString(text)
        } catch (e: Exception) {
            return null
        }
        if (!el.isJsonObject) return null
        val o = el.asJsonObject
        val idEl = o.get("id")
        val hasId = idEl != null && !idEl.isJsonNull
        val method = o.get("method")?.takeIf { !it.isJsonNull }?.asString
        val params = o.get("params")?.takeIf { it.isJsonObject }?.asJsonObject ?: JsonObject()

        if (method != null && hasId) {
            val id: Any = idOf(idEl)
            return RpcIncoming.Request(id, method, params)
        }
        if (method != null) {
            return RpcIncoming.Notification(method, params)
        }
        if (hasId) {
            val id: Any = idOf(idEl)
            val result = if (o.has("result") && !o.get("result").isJsonNull) o.get("result") else null
            val error = o.get("error")?.takeIf { it.isJsonObject }?.asJsonObject?.let { err ->
                RpcError(
                    err.get("code")?.asInt ?: -32000,
                    err.get("message")?.asString ?: "rpc error",
                    err.get("data"),
                )
            }
            return RpcIncoming.Response(id, result, error)
        }
        return null
    }

    private fun idOf(el: JsonElement): Any {
        return if (el.isJsonPrimitive) {
            val p = el.asJsonPrimitive
            if (p.isNumber) p.asLong else p.asString
        } else {
            el.asString
        }
    }

    fun response(id: Any?, result: JsonElement?): String {
        val o = JsonObject()
        o.addProperty("jsonrpc", JSON_RPC_VERSION)
        if (id != null) o.add("id", Json.toTree(id)) else o.add("id", JsonNull.INSTANCE)
        o.add("result", result ?: JsonNull.INSTANCE)
        return o.toString()
    }

    fun responseError(id: Any?, code: Int, message: String, data: JsonElement? = null): String {
        val o = JsonObject()
        o.addProperty("jsonrpc", JSON_RPC_VERSION)
        if (id != null) o.add("id", Json.toTree(id)) else o.add("id", JsonNull.INSTANCE)
        o.add("error", RpcError(code, message, data).toJson())
        return o.toString()
    }

    fun notification(method: String, params: JsonObject): String {
        val o = JsonObject()
        o.addProperty("jsonrpc", JSON_RPC_VERSION)
        o.addProperty("method", method)
        o.add("params", params)
        return o.toString()
    }

    fun request(id: Any, method: String, params: JsonObject): String {
        val o = JsonObject()
        o.addProperty("jsonrpc", JSON_RPC_VERSION)
        o.add("id", Json.toTree(id))
        o.addProperty("method", method)
        o.add("params", params)
        return o.toString()
    }
}
