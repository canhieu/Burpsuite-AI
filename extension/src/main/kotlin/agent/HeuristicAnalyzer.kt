package agent

import agent.http.RawHttpMessage

data class SignalBundle(
    val fingerprint: String,
    val time: Long,
    val method: String,
    val url: String,
    val status: Int,
    val score: Int,
    val flags: List<String>,
    val reflection: String?,
    val requestDigest: String,
    val responseDigest: String,
)

/**
 * Zero-cost heuristic triage over a request/response pair.
 * Computes a signal score; only bundles scoring >= threshold are queued for LLM analysis.
 */
object HeuristicAnalyzer {

    private val stackTrace = listOf(
        "at java.", "at org.", "at com.", "at sun.",
        "Exception", "StackOverflowError", "NullPointerException", "IllegalArgumentException",
        "SQLSyntaxError", "SQLException", "Traceback (most recent call last)",
        "Undefined array key", "TypeError", "RuntimeException",
    )
    private val interestingPaths = listOf(
        "/admin", "/debug", "/swagger", "/api", "/upload", "/graphql", "/actuator",
        "/.env", "/.git/config", "/.git/HEAD", "/server-status", "/phpinfo", "/console",
        "/jenkins", "/wp-admin", "/backup", "/rest", "/v1/", "/v2/", "/login", "/auth",
    )
    private val sensitiveExt = listOf(".bak", ".sql", ".zip", ".tar.gz", ".gz", ".old", ".log", ".json", ".yaml", ".yml")
    private val sourceMaps = listOf(".js.map", ".map")

    private val uuidPattern = Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
    private val numericIdPattern = Regex("(?:/|\\?|&|_|-)(?:id|ID|user_id|uid|account|profile|file|doc|page|item|product)(?:\\d*)?=\\d{1,12}")

    fun analyze(request: RawHttpMessage, response: RawHttpMessage?, url: String, method: String): SignalBundle {
        val status = response?.statusCode() ?: 0
        val reqBody = request.bodyText
        val respBody = response?.bodyText ?: ""
        val respHeaders = response?.headers ?: emptyList()
        val flags = mutableListOf<String>()
        var score = 0

        // Response status anomalies
        when {
            status >= 500 -> { score += 3; flags += "status:$status" }
            status in 300..399 -> { score += 1; flags += "redirect:$status" }
            status == 0 -> { score += 1; flags += "no-response" }
        }

        // Body markers
        for (m in stackTrace) {
            if (respBody.contains(m, ignoreCase = true)) {
                score += 3
                flags += "body:$m"
                break
            }
        }
        for (p in sensitiveExt) {
            if (url.endsWith(p)) { score += 3; flags += "sensitive-ext:$p" }
        }
        for (m in sourceMaps) {
            if (url.contains(m) || respBody.contains(m)) { score += 2; flags += "source-map:$m" }
        }
        for (p in interestingPaths) {
            if (url.contains(p, ignoreCase = true)) { score += 1; flags += "path:$p" }
        }

        // Reflection (param value echoed in response) — XSS / HTML-injection seed
        var reflection: String? = null
        val queryIdx = url.indexOf('?')
        if (queryIdx >= 0 && respBody.isNotEmpty()) {
            val query = url.substring(queryIdx + 1)
            for (pair in query.split('&')) {
                val value = pair.substringAfter('=', "").takeIf { it.isNotBlank() } ?: continue
                if (value.length in 2..120 && respBody.contains(value)) {
                    reflection = value
                    score += 3
                    flags += "reflection"
                    break
                }
            }
        }

        // IDOR-style identifiers in URL
        if (url.contains(uuidPattern) || numericIdPattern.containsMatchIn(url)) {
            score += 1
            flags += "id-param"
        }

        // No auth header/cookie on an auth-looking path
        val hasAuth = request.headerValue("Authorization") != null || request.headerValue("Cookie") != null ||
            request.headerValue("X-Api-Key") != null
        if (!hasAuth && interestingPaths.any { url.contains(it, ignoreCase = true) } && status in 400..499) {
            score += 1
            flags += "no-auth"
        }

        // Set-Cookie with HttpOnly missing on sensitive response
        if (respHeaders.any { it.name.equals("Set-Cookie", true) && !it.value.contains("HttpOnly", true) }) {
            score += 1
            flags += "cookie-no-httponly"
        }

        // Debug/banner headers
        if (respHeaders.any { it.name.startsWith("X-Debug", true) || it.name.startsWith("X-Powered-By", true) }) {
            score += 1
            flags += "debug-header"
        }

        val fp = fingerprint(method, url, reqBody)
        return SignalBundle(
            fingerprint = fp,
            time = System.currentTimeMillis(),
            method = method,
            url = url,
            status = status,
            score = score,
            flags = flags.distinct().take(8),
            reflection = reflection,
            requestDigest = digestRequest(request),
            responseDigest = digestResponse(response),
        )
    }

    fun fingerprint(method: String, url: String, body: String): String {
        val canonical = url.substringBefore('?') // ignore volatile query values for dedupe
        val bodyHash = body.hashCode()
        return "${method.uppercase()} $canonical #$bodyHash"
    }

    private fun digestRequest(request: RawHttpMessage): String {
        val sb = StringBuilder()
        sb.append(request.startLine.trim()).append('\n')
        for (h in request.headers) {
            // redact sensitive headers entirely
            if (h.name.equals("Authorization", true) || h.name.equals("Cookie", true) ||
                h.name.equals("Proxy-Authorization", true) || h.name.equals("Api-Key", true) ||
                h.name.equals("X-Api-Key", true)
            ) continue
            sb.append(h.name).append(": ").append(h.value.take(160)).append('\n')
        }
        val body = request.bodyText
        if (body.isNotBlank()) sb.append('\n').append(body.take(600))
        return sb.toString()
    }

    private fun digestResponse(response: RawHttpMessage?): String {
        if (response == null) return ""
        val sb = StringBuilder()
        sb.append(response.startLine.trim()).append('\n')
        for (h in response.headers) {
            if (h.name.equals("Set-Cookie", true)) continue
            sb.append(h.name).append(": ").append(h.value.take(160)).append('\n')
        }
        val body = response.bodyText
        if (body.isNotBlank()) sb.append('\n').append(body.take(1500))
        return sb.toString()
    }
}

private fun RawHttpMessage.statusCode(): Int {
    val code = startLine.trim().split(' ').getOrNull(1) ?: return 0
    return code.toIntOrNull() ?: 0
}
