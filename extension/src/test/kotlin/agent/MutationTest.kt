package agent

import agent.http.Header
import agent.http.RawHttpMessage
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class MutationTest {

    private fun request(startLine: String, headers: List<Header> = emptyList(), body: ByteArray = ByteArray(0)) =
        RawHttpMessage.of(startLine, headers, body)

    @Test
    fun `replace_query rewrites query and keeps path`() {
        val msg = request("GET /search?q=cat HTTP/1.1")
        val out = Mutation("replace_query", value = "q=dog").apply(msg)
        assertEquals("GET /search?q=dog HTTP/1.1", out.startLine)
    }

    @Test
    fun `replace_path keeps existing query when new path has none`() {
        val msg = request("GET /search?q=cat HTTP/1.1")
        val out = Mutation("replace_path", path = "/api/v1").apply(msg)
        assertEquals("GET /api/v1?q=cat HTTP/1.1", out.startLine)
    }

    @Test
    fun `replace_path with query replaces target entirely`() {
        val msg = request("GET /search?q=cat HTTP/1.1")
        val out = Mutation("replace_path", path = "/admin?a=b").apply(msg)
        assertEquals("GET /admin?a=b HTTP/1.1", out.startLine)
    }

    @Test
    fun `set_method replaces verb`() {
        val msg = request("GET /x HTTP/1.1")
        val out = Mutation("set_method", value = "post").apply(msg)
        assertEquals("POST /x HTTP/1.1", out.startLine)
    }

    @Test
    fun `json_path_set sets nested value`() {
        val msg = request(
            "POST /api HTTP/1.1",
            listOf(Header("Content-Type", "application/json")),
            """{"a":{"b":1},"c":[10,20]}""".toByteArray(),
        )
        val out = Mutation("json_path_set", path = "a.b", value = "42").apply(msg)
        assertEquals("""{"a":{"b":42},"c":[10,20]}""", out.bodyText)
    }

    @Test
    fun `json_path_set supports array index`() {
        val msg = request(
            "POST /api HTTP/1.1",
            emptyList(),
            """{"items":[{"id":1},{"id":2}]}""".toByteArray(),
        )
        val out = Mutation("json_path_set", path = "items.0.id", value = "99").apply(msg)
        assertEquals("""{"items":[{"id":99},{"id":2}]}""", out.bodyText)
    }

    @Test
    fun `content-length is recomputed after body change`() {
        val msg = request(
            "POST /x HTTP/1.1",
            listOf(Header("Content-Length", "5")),
            "hello".toByteArray(),
        )
        val out = Mutation("replace_body", value = "hello world").apply(msg)
        assertEquals("hello world", out.bodyText)
        assertEquals("11", out.headerValue("Content-Length"))
    }

    @Test
    fun `set_header on content-length recomputes instead of trusting value`() {
        val msg = request(
            "POST /x HTTP/1.1",
            listOf(Header("Content-Length", "5")),
            "hello".toByteArray(),
        )
        val out = Mutation("set_header", name = "Content-Length", value = "999").apply(msg)
        assertEquals("5", out.headerValue("Content-Length"))
    }

    @Test
    fun `removing content-length with non-empty body is refused`() {
        val msg = request(
            "POST /x HTTP/1.1",
            listOf(Header("Content-Length", "5")),
            "hello".toByteArray(),
        )
        assertThrows(MutationException::class.java) {
            Mutation("remove_header", name = "Content-Length").apply(msg)
        }
    }

    @Test
    fun `removing content-length with empty body is allowed`() {
        val msg = request(
            "POST /x HTTP/1.1",
            listOf(Header("Content-Length", "0")),
            ByteArray(0),
        )
        val out = Mutation("remove_header", name = "Content-Length").apply(msg)
        assertEquals(null, out.headerValue("Content-Length"))
    }

    @Test
    fun `form_field_set updates urlencoded body`() {
        val msg = request(
            "POST /login HTTP/1.1",
            emptyList(),
            "user=alice&pass=old".toByteArray(),
        )
        val out = Mutation("form_field_set", name = "pass", value = "new").apply(msg)
        assertTrue(out.bodyText.contains("user=alice"))
        assertTrue(out.bodyText.contains("pass=new"))
        assertEquals(out.bodyText.length.toString(), out.headerValue("Content-Length"))
    }

    @Test
    fun `json_path_set creates missing intermediate objects`() {
        val msg = request(
            "POST /api HTTP/1.1",
            emptyList(),
            """{"user":{}}""".toByteArray(),
        )
        val out = Mutation("json_path_set", path = "user.profile.name", value = "bob").apply(msg)
        assertEquals("""{"user":{"profile":{"name":"bob"}}}""", out.bodyText)
    }

    @Test
    fun `json_path_set creates deep path in empty object`() {
        val msg = request(
            "POST /api HTTP/1.1",
            emptyList(),
            "{}".toByteArray(),
        )
        val out = Mutation("json_path_set", path = "a.b.c", value = "x").apply(msg)
        assertEquals("""{"a":{"b":{"c":"x"}}}""", out.bodyText)
    }

    @Test
    fun `unknown operation throws`() {
        val msg = request("GET /x HTTP/1.1")
        assertThrows(MutationException::class.java) {
            Mutation("explode").apply(msg)
        }
    }

    private fun assertTrue(condition: Boolean) {
        org.junit.jupiter.api.Assertions.assertTrue(condition)
    }
}
