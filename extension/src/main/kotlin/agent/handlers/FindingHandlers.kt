package agent

import agent.rpc.Json
import agent.rpc.RpcFailure
import com.google.gson.JsonObject

class FindingHandlers(private val ctx: AgentContext) : RpcHandler {

    override fun handles(method: String): Boolean =
        method.startsWith("finding.") || method.startsWith("evidence.")

    override fun handle(method: String, params: JsonObject): Any? {
        val rpc = ctx.rpcServer ?: throw RpcFailure(503, "rpc server not ready")
        val reply = rpc.callSidecar(method, params)
        return reply.require()
    }
}
