package agent

import agent.http.RawHttpMessage
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.google.gson.JsonPrimitive
import java.net.URLDecoder
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

class MutationException(message: String) : Exception(message)

data class Mutation(
    val operation: String,
    val name: String? = null,
    val value: String? = null,
    val path: String? = null,
) {

    fun apply(msg: RawHttpMessage): RawHttpMessage {
        if (!msg.isRequest) throw MutationException("mutation only applies to requests")
        return when (operation) {
            "replace_path" -> replacePath(msg)
            "replace_query" -> replaceQuery(msg)
            "set_header" -> setHeader(msg)
            "remove_header" -> removeHeader(msg)
            "replace_body" -> msg.withBody((value ?: "").toByteArray(StandardCharsets.UTF_8))
            "json_path_set" -> jsonPathSet(msg)
            "form_field_set" -> formFieldSet(msg)
            "set_method" -> setMethod(msg)
            else -> throw MutationException("unknown operation: $operation")
        }
    }

    private fun replacePath(msg: RawHttpMessage): RawHttpMessage {
        val newPath = path ?: throw MutationException("replace_path requires path")
        val target = targetOf(msg.startLine) ?: throw MutationException("cannot parse request line")
        val newTarget = if (newPath.contains('?')) newPath else newPath + queryOf(target).let { if (it.isEmpty()) "" else "?$it" }
        return msg.copyWith(startLine = rebuildRequestLine(msg.startLine, newTarget))
    }

    private fun replaceQuery(msg: RawHttpMessage): RawHttpMessage {
        val newQuery = (value ?: "").removePrefix("?")
        val target = targetOf(msg.startLine) ?: throw MutationException("cannot parse request line")
        val pathWithoutQuery = target.substringBefore('?')
        val newTarget = if (newQuery.isEmpty()) pathWithoutQuery else "$pathWithoutQuery?$newQuery"
        return msg.copyWith(startLine = rebuildRequestLine(msg.startLine, newTarget))
    }

    private fun setHeader(msg: RawHttpMessage): RawHttpMessage {
        val n = name ?: throw MutationException("set_header requires name")
        val v = value ?: throw MutationException("set_header requires value")
        return if (n.equals("Content-Length", ignoreCase = true)) {
            msg.recomputeContentLength()
        } else {
            msg.withHeader(n, v)
        }
    }

    private fun removeHeader(msg: RawHttpMessage): RawHttpMessage {
        val n = name ?: throw MutationException("remove_header requires name")
        if (n.equals("Content-Length", ignoreCase = true) && msg.body.isNotEmpty()) {
            throw MutationException("cannot remove Content-Length with non-empty body; use replace_body")
        }
        return msg.withoutHeader(n)
    }

    private fun jsonPathSet(msg: RawHttpMessage): RawHttpMessage {
        val p = path ?: throw MutationException("json_path_set requires path")
        val v = value ?: throw MutationException("json_path_set requires value")
        val bodyText = msg.bodyText
        val root = try {
            JsonParser.parseString(bodyText)
        } catch (e: Exception) {
            throw MutationException("body is not valid JSON")
        }
        if (!root.isJsonObject && !root.isJsonArray) throw MutationException("body is not a JSON object/array")
        setByDotPath(root, p, parseJsonValue(v))
        val out = root.toString()
        return msg.withBody(out.toByteArray(StandardCharsets.UTF_8))
    }

    private fun formFieldSet(msg: RawHttpMessage): RawHttpMessage {
        val n = name ?: throw MutationException("form_field_set requires name")
        val v = value ?: throw MutationException("form_field_set requires value")
        val bodyText = msg.bodyText
        val pairs = LinkedHashMap<String, String>()
        if (bodyText.isNotBlank()) {
            for (pair in bodyText.split("&")) {
                if (pair.isEmpty()) continue
                val idx = pair.indexOf('=')
                if (idx < 0) {
                    pairs[decode(pair)] = ""
                } else {
                    pairs[decode(pair.substring(0, idx))] = decode(pair.substring(idx + 1))
                }
            }
        }
        pairs[n] = v
        val out = pairs.entries.joinToString("&") { (k, val_) -> "${encode(k)}=${encode(val_)}" }
        return msg.withBody(out.toByteArray(StandardCharsets.UTF_8))
    }

    private fun setMethod(msg: RawHttpMessage): RawHttpMessage {
        val m = value ?: throw MutationException("set_method requires value")
        val parts = msg.startLine.split(" ")
        if (parts.size < 3) throw MutationException("cannot parse request line")
        val target = targetOf(msg.startLine) ?: throw MutationException("cannot parse request line")
        val httpVersion = parts.last()
        return msg.copyWith(startLine = RawHttpMessage.requestLine(m.uppercase(), target, httpVersion))
    }

    companion object {
        fun parse(o: JsonObject): Mutation {
            val op = o.get("operation")?.asString ?: throw MutationException("mutation missing operation")
            val name = o.get("name")?.takeIf { !it.isJsonNull }?.asString
            val value = o.get("value")?.takeIf { !it.isJsonNull }?.asString
            val path = o.get("path")?.takeIf { !it.isJsonNull }?.asString
            return Mutation(op, name, value, path)
        }

        fun parseSafe(o: JsonObject?): Mutation? {
            if (o == null) return null
            return try {
                parse(o)
            } catch (e: MutationException) {
                null
            }
        }

        fun targetOf(startLine: String): String? {
            val parts = startLine.trim().split(Regex("\\s+"))
            return if (parts.size >= 2) parts[1] else null
        }

        fun queryOf(target: String): String {
            val q = target.substringAfter('?', "")
            return q
        }

        fun rebuildRequestLine(startLine: String, newTarget: String): String {
            val parts = startLine.trim().split(Regex("\\s+"))
            return if (parts.size >= 3) "${parts[0]} $newTarget ${parts[2]}" else "$newTarget $startLine"
        }

        fun parseJsonValue(raw: String): Any {
            return try {
                JsonParser.parseString(raw)
            } catch (e: Exception) {
                JsonPrimitive(raw)
            }
        }

        fun setByDotPath(node: Any, dotPath: String, value: Any) {
            val segments = dotPath.split('.').map { it.trim() }
                .filter { it.isNotEmpty() }
                .flatMap { seg ->
                    if (seg.contains('[') && seg.endsWith("]")) {
                        val name = seg.substringBefore('[')
                        val idx = seg.substringAfter('[').removeSuffix("]")
                        if (name.isEmpty()) listOf(idx) else listOf(name, idx)
                    } else listOf(seg)
                }
            if (segments.isEmpty()) throw MutationException("empty json path")
            setSegment(node, segments, 0, value)
        }

        @Suppress("UNCHECKED_CAST")
        private fun setSegment(node: Any, segments: List<String>, depth: Int, value: Any) {
            val isLast = depth == segments.size - 1
            val seg = segments[depth]
            when (node) {
                is com.google.gson.JsonObject -> {
                    val exists = node.has(seg) && !node.get(seg).isJsonNull
                    if (isLast) {
                        addToObject(node, seg, value)
                    } else {
                        val child: com.google.gson.JsonElement = if (exists) {
                            node.get(seg)
                        } else {
                            val created = if (segments.getOrNull(depth + 1)?.toIntOrNull() != null) {
                                com.google.gson.JsonArray()
                            } else {
                                com.google.gson.JsonObject()
                            }
                            node.add(seg, created)
                            created
                        }
                        if (!child.isJsonObject && !child.isJsonArray) {
                            val created = if (segments.getOrNull(depth + 1)?.toIntOrNull() != null) {
                                com.google.gson.JsonArray()
                            } else {
                                com.google.gson.JsonObject()
                            }
                            node.add(seg, created)
                            setSegment(created, segments, depth + 1, value)
                        } else {
                            setSegment(child, segments, depth + 1, value)
                        }
                    }
                }
                is com.google.gson.JsonArray -> {
                    val idx = seg.toIntOrNull() ?: throw MutationException("expected array index, got '$seg'")
                    while (node.size() <= idx) node.add(com.google.gson.JsonNull.INSTANCE)
                    if (isLast) {
                        addToArray(node, idx, value)
                    } else {
                        val current = node.get(idx)
                        if (current.isJsonNull || current.isJsonPrimitive) {
                            val created = if (segments.getOrNull(depth + 1)?.toIntOrNull() != null) {
                                com.google.gson.JsonArray()
                            } else {
                                com.google.gson.JsonObject()
                            }
                            node.set(idx, created)
                            setSegment(created, segments, depth + 1, value)
                        } else {
                            setSegment(current, segments, depth + 1, value)
                        }
                    }
                }
                else -> throw MutationException("cannot traverse non-object node at '$seg'")
            }
        }

        private fun addToObject(node: com.google.gson.JsonObject, key: String, value: Any) {
            when (value) {
                is com.google.gson.JsonElement -> node.add(key, value)
                is Number -> node.addProperty(key, value)
                is Boolean -> node.addProperty(key, value)
                else -> node.addProperty(key, value.toString())
            }
        }

        private fun addToArray(node: com.google.gson.JsonArray, idx: Int, value: Any) {
            when (value) {
                is com.google.gson.JsonElement -> node.set(idx, value)
                is Number -> node.set(idx, com.google.gson.JsonPrimitive(value))
                is Boolean -> node.set(idx, com.google.gson.JsonPrimitive(value))
                else -> node.set(idx, com.google.gson.JsonPrimitive(value.toString()))
            }
        }

        private fun decode(s: String): String = URLDecoder.decode(s, StandardCharsets.UTF_8)
        private fun encode(s: String): String = URLEncoder.encode(s, StandardCharsets.UTF_8)
    }
}
