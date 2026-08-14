package agent

import agent.http.Header
import agent.http.RawHttpMessage
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class RedactorTest {

    @Test
    fun `masks authorization cookie and api key headers`() {
        val msg = RawHttpMessage.of(
            "GET /x HTTP/1.1",
            listOf(
                Header("Host", "example.com"),
                Header("Authorization", "Bearer secret-token-123"),
                Header("Cookie", "session=abc123; theme=dark"),
                Header("X-Api-Key", "k_1234567890"),
                Header("Accept", "application/json"),
            ),
            ByteArray(0),
        )

        val redacted = Redactor.redact(msg)

        assertEquals("{{redacted}}", redacted.headerValue("Authorization"))
        assertEquals("session={{redacted}}; theme={{redacted}}", redacted.headerValue("Cookie"))
        assertEquals("{{redacted}}", redacted.headerValue("X-Api-Key"))
        assertEquals("application/json", redacted.headerValue("Accept"))
        assertEquals("example.com", redacted.headerValue("Host"))
    }

    @Test
    fun `masks password and token like headers`() {
        val msg = RawHttpMessage.of(
            "POST /login HTTP/1.1",
            listOf(
                Header("Host", "example.com"),
                Header("X-Auth-Token", "tok123"),
                Header("Password", "hunter2"),
                Header("Content-Type", "text/plain"),
            ),
            ByteArray(0),
        )
        val redacted = Redactor.redact(msg)
        assertEquals("{{redacted}}", redacted.headerValue("X-Auth-Token"))
        assertEquals("{{redacted}}", redacted.headerValue("Password"))
        assertEquals("text/plain", redacted.headerValue("Content-Type"))
    }

    @Test
    fun `masks set-cookie on responses`() {
        val msg = RawHttpMessage.of(
            "HTTP/1.1 200 OK",
            listOf(Header("Set-Cookie", "sid=deadbeef; Path=/")),
            ByteArray(0),
        )
        val redacted = Redactor.redact(msg)
        assertEquals("sid={{redacted}}; Path=/", redacted.headerValue("Set-Cookie"))
    }

    @Test
    fun `body and headers survive roundtrip`() {
        val body = """{"user":"alice"}"""
        val msg = RawHttpMessage.of(
            "POST /api HTTP/1.1",
            listOf(
                Header("Host", "example.com"),
                Header("Content-Type", "application/json"),
                Header("Cookie", "session=x"),
            ),
            body.toByteArray(),
        )
        val redacted = Redactor.redact(msg)
        assertEquals(body, redacted.bodyText)
        assertEquals("application/json", redacted.headerValue("Content-Type"))
        assertTrue(redacted.headerValue("Cookie")!!.startsWith("session="))
        assertFalse(redacted.headerValue("Cookie")!!.contains("x"))
        val bytes = redacted.toBytes()
        val reparsed = RawHttpMessage.parse(bytes)
        assertEquals(msg.startLine, reparsed.startLine)
        assertEquals(msg.bodyText, reparsed.bodyText)
    }

    @Test
    fun `isSensitiveHeader matches expected set`() {
        assertTrue(Redactor.isSensitiveHeader("Authorization"))
        assertTrue(Redactor.isSensitiveHeader("Cookie"))
        assertTrue(Redactor.isSensitiveHeader("Set-Cookie"))
        assertTrue(Redactor.isSensitiveHeader("Proxy-Authorization"))
        assertTrue(Redactor.isSensitiveHeader("x-api-key"))
        assertTrue(Redactor.isSensitiveHeader("X_AUTH_TOKEN"))
        assertFalse(Redactor.isSensitiveHeader("Accept"))
        assertFalse(Redactor.isSensitiveHeader("Host"))
    }
}
