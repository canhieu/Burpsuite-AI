package agent

import agent.rpc.Json
import agent.rpc.RpcIncoming
import agent.rpc.RpcMessage
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class RpcFramingTest {

    @Test
    fun `request round-trips id and params`() {
        val params = Json.obj("host" to "example.com", "limit" to 10)
        val wire = RpcMessage.request(42L, "history.search", params)
        val parsed = RpcMessage.parse(wire)
        assertTrue(parsed is RpcIncoming.Request)
        parsed as RpcIncoming.Request
        assertEquals(42L, parsed.id)
        assertEquals("history.search", parsed.method)
        assertEquals("example.com", parsed.params.get("host").asString)
        assertEquals(10, parsed.params.get("limit").asInt)
    }

    @Test
    fun `string id is preserved`() {
        val wire = RpcMessage.request("req-1", "agent.ping", Json.obj())
        val parsed = RpcMessage.parse(wire)
        assertTrue(parsed is RpcIncoming.Request)
        assertEquals("req-1", (parsed as RpcIncoming.Request).id)
    }

    @Test
    fun `response round-trips result`() {
        val result = Json.obj("pong" to true, "version" to "0.1.0")
        val wire = RpcMessage.response(7L, result)
        val parsed = RpcMessage.parse(wire)
        assertTrue(parsed is RpcIncoming.Response)
        parsed as RpcIncoming.Response
        assertEquals(7L, parsed.id)
        assertEquals(true, parsed.result?.asJsonObject?.get("pong")?.asBoolean)
    }

    @Test
    fun `error response round-trips code and message`() {
        val wire = RpcMessage.responseError(1L, 401, "handshake failed: invalid token")
        val parsed = RpcMessage.parse(wire)
        assertTrue(parsed is RpcIncoming.Response)
        parsed as RpcIncoming.Response
        assertEquals(401, parsed.error?.code)
        assertTrue(parsed.error!!.message.contains("invalid token"))
    }

    @Test
    fun `notification has no id and carries method`() {
        val params = Json.obj("type" to "text", "data" to "hello")
        val wire = RpcMessage.notification("agent.event", params)
        val parsed = RpcMessage.parse(wire)
        assertTrue(parsed is RpcIncoming.Notification)
        parsed as RpcIncoming.Notification
        assertEquals("agent.event", parsed.method)
        assertEquals("hello", parsed.params.get("data").asString)
    }

    @Test
    fun `streaming event frames serialize and parse`() {
        val event = Json.obj("type" to "tool_call", "data" to Json.obj("name" to "history.search", "arguments" to Json.obj()))
        val wire = RpcMessage.notification("agent.event", event)
        val parsed = RpcMessage.parse(wire)
        assertTrue(parsed is RpcIncoming.Notification)
        val data = (parsed as RpcIncoming.Notification).params.get("data").asJsonObject
        assertEquals("history.search", data.get("name").asString)
    }

    @Test
    fun `unknown method without id parses as notification`() {
        val wire = RpcMessage.notification("agent.approve", Json.obj("requestId" to "x", "approved" to true))
        val parsed = RpcMessage.parse(wire)
        assertTrue(parsed is RpcIncoming.Notification)
        assertEquals(true, (parsed as RpcIncoming.Notification).params.get("approved").asBoolean)
    }

    @Test
    fun `garbage input returns null`() {
        assertEquals(null, RpcMessage.parse("not json at all"))
        assertEquals(null, RpcMessage.parse("[1,2,3]"))
    }
}
