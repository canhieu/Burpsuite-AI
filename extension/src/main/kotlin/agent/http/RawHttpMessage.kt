package agent.http

data class Header(val name: String, val value: String)

class RawHttpMessage private constructor(
    val startLine: String,
    val headers: List<Header>,
    val body: ByteArray,
    val isRequest: Boolean,
) {
    val bodyText: String
        get() = String(body, Charsets.UTF_8)

    fun headerValue(name: String): String? =
        headers.firstOrNull { it.name.equals(name, ignoreCase = true) }?.value

    fun headerValues(name: String): List<String> =
        headers.filter { it.name.equals(name, ignoreCase = true) }.map { it.value }

    fun hasHeader(name: String): Boolean =
        headers.any { it.name.equals(name, ignoreCase = true) }

    fun withoutHeader(name: String): RawHttpMessage =
        copyWith(headers = headers.filterNot { it.name.equals(name, ignoreCase = true) })

    fun withHeader(name: String, value: String): RawHttpMessage {
        val existing = headers.firstOrNull { it.name.equals(name, ignoreCase = true) }
        val newHeaders = if (existing == null) {
            headers + Header(name, value)
        } else {
            headers.map { if (it.name.equals(name, ignoreCase = true)) Header(name, value) else it }
        }
        return copyWith(headers = newHeaders)
    }

    fun withBody(newBody: ByteArray): RawHttpMessage {
        val noCl = removeContentLength(headers)
        return copyWith(headers = noCl + Header("Content-Length", newBody.size.toString()), body = newBody)
    }

    fun recomputeContentLength(): RawHttpMessage {
        val noCl = removeContentLength(headers)
        return copyWith(headers = noCl + Header("Content-Length", body.size.toString()))
    }

    fun copyWith(
        startLine: String = this.startLine,
        headers: List<Header> = this.headers,
        body: ByteArray = this.body,
    ): RawHttpMessage = RawHttpMessage(startLine, headers, body, isRequest)

    fun toBytes(): ByteArray {
        val sb = StringBuilder(startLine)
        sb.append("\r\n")
        for (h in headers) {
            sb.append(h.name).append(": ").append(h.value).append("\r\n")
        }
        sb.append("\r\n")
        val head = sb.toString().toByteArray(Charsets.ISO_8859_1)
        val out = ByteArray(head.size + body.size)
        System.arraycopy(head, 0, out, 0, head.size)
        System.arraycopy(body, 0, out, head.size, body.size)
        return out
    }

    companion object {
        fun requestLine(method: String, target: String, httpVersion: String = "HTTP/1.1"): String =
            "$method $target $httpVersion"

        fun parse(bytes: ByteArray): RawHttpMessage {
            val (headBytes, bodyBytes, lineSep) = split(bytes)
            val head = String(headBytes, Charsets.ISO_8859_1)
            val lines = head.split(lineSep)
            val startLine = lines.firstOrNull()?.trim().orEmpty()
            val headerLines = if (lines.size > 1) lines.drop(1) else emptyList()
            val headers = ArrayList<Header>(headerLines.size)
            for (line in headerLines) {
                val trimmed = line.trim()
                if (trimmed.isEmpty()) continue
                val idx = trimmed.indexOf(':')
                if (idx > 0) {
                    headers.add(Header(trimmed.substring(0, idx).trim(), trimmed.substring(idx + 1).trim()))
                }
            }
            val isRequest = !startLine.startsWith("HTTP/", ignoreCase = true)
            return RawHttpMessage(startLine, headers, bodyBytes, isRequest)
        }

        fun parse(text: String): RawHttpMessage = parse(text.toByteArray(Charsets.ISO_8859_1))

        fun of(startLine: String, headers: List<Header>, body: ByteArray): RawHttpMessage =
            RawHttpMessage(startLine, headers, body, !startLine.startsWith("HTTP/", ignoreCase = true))

        private fun removeContentLength(headers: List<Header>): List<Header> =
            headers.filterNot { it.name.equals("Content-Length", ignoreCase = true) }

        private fun split(bytes: ByteArray): Triple<ByteArray, ByteArray, String> {
            val crlf = indexOf(bytes, 0, bytes.size, "\r\n\r\n".toByteArray(Charsets.ISO_8859_1))
            if (crlf >= 0) {
                val body = ByteArray(bytes.size - crlf - 4)
                System.arraycopy(bytes, crlf + 4, body, 0, body.size)
                val head = ByteArray(crlf)
                System.arraycopy(bytes, 0, head, 0, crlf)
                return Triple(head, body, "\r\n")
            }
            val lf = indexOf(bytes, 0, bytes.size, "\n\n".toByteArray(Charsets.ISO_8859_1))
            if (lf >= 0) {
                val body = ByteArray(bytes.size - lf - 2)
                System.arraycopy(bytes, lf + 2, body, 0, body.size)
                val head = ByteArray(lf)
                System.arraycopy(bytes, 0, head, 0, lf)
                return Triple(head, body, "\n")
            }
            return Triple(bytes.copyOf(), ByteArray(0), "\r\n")
        }

        private fun indexOf(haystack: ByteArray, from: Int, to: Int, needle: ByteArray): Int {
            if (needle.isEmpty() || needle.size > haystack.size) return -1
            var i = from
            while (i <= to - needle.size) {
                var j = 0
                while (j < needle.size && haystack[i + j] == needle[j]) j++
                if (j == needle.size) return i
                i++
            }
            return -1
        }
    }
}
