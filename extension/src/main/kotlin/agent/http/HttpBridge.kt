package agent.http

import agent.Mutation
import burp.api.montoya.core.ByteArray
import burp.api.montoya.http.HttpService
import burp.api.montoya.http.message.HttpRequestResponse
import burp.api.montoya.http.message.requests.HttpRequest
import burp.api.montoya.http.message.responses.HttpResponse
import burp.api.montoya.proxy.ProxyHttpRequestResponse

class RefItem(
    val request: HttpRequest,
    val response: HttpResponse?,
    val service: HttpService?,
    val url: String?,
) {
    companion object {
        fun fromProxy(p: ProxyHttpRequestResponse): RefItem =
            RefItem(p.finalRequest(), p.response(), p.httpService(), p.url())

        fun fromHttpRequestResponse(rr: HttpRequestResponse): RefItem =
            RefItem(rr.request(), rr.response(), rr.httpService(), rr.url())
    }
}

object HttpBridge {

    fun raw(request: HttpRequest): RawHttpMessage = RawHttpMessage.parse(request.toByteArray().getBytes())

    fun raw(response: HttpResponse): RawHttpMessage = RawHttpMessage.parse(response.toByteArray().getBytes())

    fun raw(rr: HttpRequestResponse): Pair<RawHttpMessage, RawHttpMessage?> =
        raw(rr.request()) to rr.response()?.let { raw(it) }

    fun request(raw: RawHttpMessage, service: HttpService?): HttpRequest {
        val req = HttpRequest.httpRequest(ByteArray.byteArray(*raw.toBytes()))
        return if (service != null) req.withService(service) else req
    }

    fun requestResponse(request: HttpRequest, response: HttpResponse?): HttpRequestResponse {
        val resp = response ?: HttpResponse.httpResponse(ByteArray.byteArrayOfLength(0))
        return HttpRequestResponse.httpRequestResponse(request, resp)
    }

    fun serviceFor(raw: RawHttpMessage, provided: HttpService?): HttpService? {
        if (provided != null) return provided
        val hostHeader = raw.headerValue("Host") ?: return null
        val host = hostHeader.substringBefore(':')
        val portStr = hostHeader.substringAfter(':', "").takeIf { it.isNotBlank() }
        val secure = portStr == "443"
        val port = portStr?.toIntOrNull() ?: if (secure) 443 else 80
        return HttpService.httpService(host, port, secure)
    }

    fun absoluteUrl(raw: RawHttpMessage, service: HttpService?): String {
        val target = Mutation.targetOf(raw.startLine) ?: ""
        val hostHeader = raw.headerValue("Host")
        val host = service?.host() ?: hostHeader?.substringBefore(':') ?: return target
        val secure = service?.secure() ?: (service?.port() == 443) || (hostHeader?.contains(":443") == true)
        val port = service?.port() ?: (hostHeader?.substringAfter(':', "")?.toIntOrNull() ?: (if (secure) 443 else 80))
        val scheme = if (secure) "https" else "http"
        val defaultPort = if (secure) 443 else 80
        val portPart = if (port == defaultPort) "" else ":$port"
        return "$scheme://$host$portPart$target"
    }

    fun methodOf(raw: RawHttpMessage): String = raw.startLine.trim().substringBefore(' ').uppercase()
}
