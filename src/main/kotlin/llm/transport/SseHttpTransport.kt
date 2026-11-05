package ink.chyk.edelweiss.llm.transport

import io.ktor.client.*
import io.ktor.client.request.*
import io.ktor.client.statement.*
import io.ktor.http.*
import io.ktor.utils.io.*
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlin.time.Duration.Companion.seconds

data class SseFrame(
    val event: String? = null,
    val data: String,
    val id: String? = null,
)

class LlmHttpException(
    val status: Int,
    val responseBody: String,
) : RuntimeException("LLM API returned HTTP $status: $responseBody")

class SseHttpTransport(
    private val httpClient: HttpClient,
) {
    fun post(
        url: String,
        timeoutSec: Long?,
        headers: HeadersBuilder.() -> Unit,
        body: JsonObject,
    ): Flow<SseFrame> = flow {
        val request = suspend {
            httpClient.preparePost(url) {
                contentType(ContentType.Application.Json)
                headers(headers)
                setBody(body.toString())
            }.execute { response ->
                if (response.status.value !in 200..299) {
                    throw LlmHttpException(
                        status = response.status.value,
                        responseBody = response.bodyAsText(),
                    )
                }

                val channel = response.bodyAsChannel()
                var event: String? = null
                var id: String? = null
                val data = mutableListOf<String>()

                suspend fun emitFrame() {
                    if (data.isNotEmpty()) {
                        emit(
                            SseFrame(
                                event = event,
                                data = data.joinToString("\n"),
                                id = id,
                            ),
                        )
                    }
                    event = null
                    data.clear()
                }

                while (true) {
                    val line = channel.readLine() ?: break
                    if (line.isEmpty()) {
                        emitFrame()
                        continue
                    }
                    if (line.startsWith(':')) {
                        continue
                    }

                    val separator = line.indexOf(':')
                    val field = if (separator == -1) line else line.substring(0, separator)
                    val value = if (separator == -1) {
                        ""
                    } else {
                        line.substring(separator + 1).removePrefix(" ")
                    }

                    when (field) {
                        "event" -> event = value
                        "data" -> data += value
                        "id" -> id = value
                    }
                }
                emitFrame()
            }
        }

        if (timeoutSec == null) {
            request()
        } else {
            require(timeoutSec > 0) {
                "timeoutSec must be positive"
            }
            withTimeout(timeoutSec.seconds) {
                request()
            }
        }
    }
}
