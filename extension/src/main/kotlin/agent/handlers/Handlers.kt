package agent

import agent.rpc.Json
import agent.rpc.RpcFailure
import com.google.gson.JsonElement
import com.google.gson.JsonObject

interface RpcHandler {
    fun handles(method: String): Boolean
    fun handle(method: String, params: JsonObject): Any?
}

class Handlers(private val ctx: AgentContext) {

    private val subs: List<RpcHandler> = listOf(
        SelectionHandlers(ctx),
        HistoryHandlers(ctx),
        HttpHandlers(ctx),
        ToolHandlers(ctx),
        ScanHandlers(ctx),
        FindingHandlers(ctx),
    )

    fun dispatch(id: Any, method: String, params: JsonObject): JsonElement {
        val idemKey = params.get("idempotencyKey")?.takeIf { !it.isJsonNull }?.asString
        if (idemKey != null) {
            ctx.idempotency.get(idemKey)?.let { return it }
        }
        val sub = subs.firstOrNull { it.handles(method) }
            ?: throw RpcFailure(-32601, "method not found: $method")
        val result = sub.handle(method, params)
        val tree = Json.toTree(result)
        if (idemKey != null) ctx.idempotency.put(idemKey, tree)
        return tree
    }
}
