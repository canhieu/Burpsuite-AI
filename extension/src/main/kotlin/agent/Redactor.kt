package agent

import agent.http.Header
import agent.http.RawHttpMessage

object Redactor {

    private const val MASK = "{{redacted}}"

    private val exactSensitive = Regex("(?i)^(authorization|cookie|set-cookie|proxy-authorization)$")
    private val partialSensitive = Regex("(?i)(token|api[_-]?key|password|secret)")

    fun isSensitiveHeader(name: String): Boolean {
        val n = name.trim()
        return exactSensitive.matches(n) || partialSensitive.containsMatchIn(n)
    }

    fun maskCookieValue(raw: String): String {
        val attributes = setOf("path", "domain", "expires", "max-age", "secure", "httponly", "samesite", "partitioned")
        return raw.split(";").joinToString(";") { pair ->
            val idx = pair.indexOf('=')
            if (idx < 0) {
                pair
            } else {
                val name = pair.substring(0, idx).trim().lowercase()
                if (name in attributes) pair else pair.substring(0, idx + 1) + MASK
            }
        }
    }

    fun maskHeaderValue(name: String, value: String): String {
        val n = name.trim()
        return when {
            n.equals("Cookie", ignoreCase = true) || n.equals("Set-Cookie", ignoreCase = true) ->
                maskCookieValue(value)
            n.equals("Authorization", ignoreCase = true) || n.equals("Proxy-Authorization", ignoreCase = true) ->
                MASK
            else -> MASK
        }
    }

    fun redact(msg: RawHttpMessage): RawHttpMessage {
        val headers = msg.headers.map { h ->
            if (isSensitiveHeader(h.name)) Header(h.name, maskHeaderValue(h.name, h.value)) else h
        }
        return RawHttpMessage.of(msg.startLine, headers, msg.body)
    }
}
