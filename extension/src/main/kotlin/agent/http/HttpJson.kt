package agent.http

import agent.Redactor
import agent.rpc.Json
import com.google.gson.JsonObject
import java.nio.charset.StandardCharsets

object HttpJson {

    const val DEFAULT_MAX_BODY = 50000

    fun toJson(msg: RawHttpMessage, redact: Boolean = true, maxBody: Int = DEFAULT_MAX_BODY): JsonObject {
        val src = if (redact) Redactor.redact(msg) else msg
        val o = JsonObject()
        o.addProperty("startLine", src.startLine)
        val headers = JsonObject()
        for (h in src.headers) {
            val prev = headers.get(h.name)
            headers.addProperty(h.name, if (prev == null) h.value else prev.asString + "\n" + h.value)
        }
        o.add("headers", headers)
        val bodyText = src.bodyText
        if (src.body.size > maxBody) {
            val slice = src.body.copyOfRange(0, maxBody)
            o.addProperty("body", String(slice, StandardCharsets.UTF_8))
            o.addProperty("bodyOffset", maxBody)
            o.addProperty("bodyTruncated", true)
        } else {
            o.addProperty("body", bodyText)
            o.addProperty("bodyTruncated", false)
        }
        return o
    }

    fun fromJson(o: JsonObject): RawHttpMessage {
        val startLine = o.get("startLine")?.asString ?: throw IllegalArgumentException("message missing startLine")
        val headers = mutableListOf<Header>()
        o.get("headers")?.takeIf { it.isJsonObject }?.asJsonObject?.entrySet()?.forEach { (name, valueEl) ->
            val value = valueEl.asString
            for (v in value.split("\n")) {
                headers.add(Header(name, v))
            }
        }
        val body = o.get("body")?.asString?.toByteArray(StandardCharsets.UTF_8) ?: ByteArray(0)
        return RawHttpMessage.of(startLine, headers, body)
    }

    fun messageRef(projectId: String, source: String, id: Any): JsonObject =
        Json.obj("projectId" to projectId, "source" to source, "id" to id)
}
