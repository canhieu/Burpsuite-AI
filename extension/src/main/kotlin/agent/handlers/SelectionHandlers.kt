package agent

import agent.http.HttpBridge
import agent.http.HttpJson
import agent.rpc.Json
import agent.rpc.RpcFailure
import com.google.gson.JsonObject

class SelectionHandlers(private val ctx: AgentContext) : RpcHandler {

    override fun handles(method: String): Boolean = method == "selected.get"

    override fun handle(method: String, params: JsonObject): Any? {
        val sel = ctx.selection.latest() ?: throw RpcFailure(404, "no selection captured")
        val rr = sel.requestResponse
        val reqRaw = HttpBridge.raw(rr.request())
        val respRaw = rr.response()?.let { HttpBridge.raw(it) }
        return Json.obj(
            "refs" to listOf(HttpJson.messageRef(ctx.projectId, "agent", sel.refId)),
            "request" to HttpJson.toJson(reqRaw),
            "response" to respRaw?.let { HttpJson.toJson(it) },
        )
    }
}
