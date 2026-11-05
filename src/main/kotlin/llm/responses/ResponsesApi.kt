package ink.chyk.edelweiss.llm.responses

import ink.chyk.edelweiss.config.ModelApiFormat
import ink.chyk.edelweiss.config.ModelConfig
import ink.chyk.edelweiss.config.ToolChoice
import ink.chyk.edelweiss.llm.*
import ink.chyk.edelweiss.llm.transport.SseHttpTransport
import io.ktor.http.*
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.serialization.json.*

class ResponsesApi(
    private val transport: SseHttpTransport,
    private val json: Json,
    private val concurrencyLimiter: LlmConcurrencyLimiter,
) : LlmApi {
    override val format: ModelApiFormat = ModelApiFormat.RESPONSES

    override fun execute(
        model: ModelConfig,
        call: LlmCall,
    ): Flow<LlmEvent> = concurrencyLimiter.execute(model) {
        streamResponse(model, call)
    }

    fun streamResponse(
        model: ModelConfig,
        call: LlmCall,
    ): Flow<LlmEvent> = flow {
        val text = StringBuilder()
        val reasoning = StringBuilder()
        val toolCalls = mutableMapOf<Int, ToolCallAccumulator>()
        var usage = LlmUsage()
        var status: String? = null
        var finalOutput: JsonArray? = null

        transport.post(
            url = endpoint(model, "responses"),
            timeoutSec = model.timeoutSec,
            headers = {
                append(HttpHeaders.Authorization, "Bearer ${model.apiKey}")
            },
            body = buildRequest(model, call),
        ).collect { frame ->
            if (frame.data == "[DONE]") {
                return@collect
            }
            val event = json.parseToJsonElement(frame.data).asObjectOrNull()
                ?: return@collect
            val type = event.string("type") ?: frame.event

            when (type) {
                "response.output_item.added" -> {
                    val item = event["item"]?.asObjectOrNull() ?: return@collect
                    if (item.string("type") == "function_call") {
                        val index = event.int("output_index") ?: 0
                        val accumulator = toolCalls.getOrPut(index) {
                            ToolCallAccumulator()
                        }
                        accumulator.callId = item.string("call_id").orEmpty()
                        accumulator.name = item.string("name").orEmpty()
                        emit(
                            LlmEvent.ToolCallDelta(
                                index = index,
                                callId = accumulator.callId,
                                name = accumulator.name,
                            ),
                        )
                    }
                }

                "response.output_text.delta" -> {
                    val delta = event.string("delta").orEmpty()
                    text.append(delta)
                    emit(LlmEvent.TextDelta(delta))
                }

                "response.reasoning_summary_text.delta",
                "response.reasoning_text.delta",
                -> {
                    val delta = event.string("delta").orEmpty()
                    reasoning.append(delta)
                    emit(LlmEvent.ReasoningDelta(delta))
                }

                "response.function_call_arguments.delta" -> {
                    val index = event.int("output_index") ?: 0
                    val delta = event.string("delta").orEmpty()
                    toolCalls.getOrPut(index) {
                        ToolCallAccumulator()
                    }.arguments.append(delta)
                    emit(
                        LlmEvent.ToolCallDelta(
                            index = index,
                            argumentsDelta = delta,
                        ),
                    )
                }

                "response.output_item.done" -> {
                    val index = event.int("output_index") ?: 0
                    val item = event["item"]?.asObjectOrNull() ?: return@collect
                    if (item.string("type") == "function_call") {
                        val accumulator = toolCalls.getOrPut(index) {
                            ToolCallAccumulator()
                        }
                        accumulator.callId = item.string("call_id").orEmpty()
                        accumulator.name = item.string("name").orEmpty()
                        item.string("arguments")?.let {
                            accumulator.arguments.clear()
                            accumulator.arguments.append(it)
                        }
                    }
                }

                "response.completed",
                "response.incomplete",
                "response.failed",
                -> {
                    val response = event["response"]?.asObjectOrNull()
                        ?: return@collect
                    status = response.string("status")
                    finalOutput = response["output"] as? JsonArray
                    response["usage"]?.asObjectOrNull()?.let {
                        usage = LlmUsage(
                            inputTokens = it.long("input_tokens") ?: 0,
                            outputTokens = it.long("output_tokens") ?: 0,
                            cacheReadTokens = it["input_tokens_details"]
                                ?.asObjectOrNull()
                                ?.long("cached_tokens"),
                        )
                    }
                    if (type == "response.failed") {
                        val error = response["error"]?.asObjectOrNull()
                        throw ResponsesStreamException(
                            error?.string("message")
                                ?: "Responses API stream failed",
                        )
                    }
                }

                "error" -> {
                    throw ResponsesStreamException(
                        event.string("message") ?: "Responses API stream failed",
                    )
                }
            }
        }

        val content = finalOutput
            ?.let(::parseFinalOutput)
            ?: buildList {
                if (reasoning.isNotEmpty()) {
                    add(
                        LlmOutputContent.Reasoning(
                            sourceFormat = format,
                            text = reasoning.toString(),
                        ),
                    )
                }
                if (text.isNotEmpty()) {
                    add(LlmOutputContent.Text(text.toString()))
                }
                toolCalls.toSortedMap().values.forEach {
                    add(
                        LlmOutputContent.ToolCall(
                            callId = it.callId,
                            name = it.name,
                            arguments = json.parseArguments(it.arguments.toString()),
                        ),
                    )
                }
            }
        emit(
            LlmEvent.Completed(
                LlmResult(
                    content = content,
                    usage = usage,
                    finishReason = status,
                ),
            ),
        )
    }

    private fun buildRequest(
        model: ModelConfig,
        call: LlmCall,
    ): JsonObject = buildRequestBody(model.extraBody) {
        put("model", model.model)
        if (model.extraBody?.containsKey("store") != true) {
            put("store", false)
        }
        put(
            "input",
            buildJsonArray {
                var crossReasoningIndex = 0
                call.messages.forEach { message ->
                    when (message) {
                        is LlmMessage.User -> add(
                            buildJsonObject {
                                put("role", "user")
                                put("content", inputContentToResponsesJson(message.content))
                            },
                        )

                        is LlmMessage.Assistant ->
                            message.content.forEach { content ->
                                when (content) {
                                    is LlmOutputContent.Text -> add(
                                        buildJsonObject {
                                            put("role", "assistant")
                                            put(
                                                "content",
                                                buildJsonArray {
                                                    add(
                                                        buildJsonObject {
                                                            put("type", "output_text")
                                                            put("text", content.text)
                                                        },
                                                    )
                                                },
                                            )
                                        },
                                    )

                                    is LlmOutputContent.Reasoning -> add(
                                        reasoningToResponsesJson(
                                            content,
                                            crossReasoningIndex++,
                                        ),
                                    )

                                    is LlmOutputContent.ToolCall -> add(
                                        buildJsonObject {
                                            put("type", "function_call")
                                            put("call_id", content.callId)
                                            put("name", content.name)
                                            put("arguments", content.arguments.toString())
                                        },
                                    )
                                }
                            }

                        is LlmMessage.ToolResult -> add(
                            buildJsonObject {
                                put("type", "function_call_output")
                                put("call_id", message.callId)
                                put(
                                    "output",
                                    if (
                                        message.content.size == 1 &&
                                        message.content.single() is LlmInputContent.Text
                                    ) {
                                        JsonPrimitive(
                                            (message.content.single() as LlmInputContent.Text).text,
                                        )
                                    } else {
                                        inputContentToResponsesJson(message.content)
                                    },
                                )
                            },
                        )
                    }
                }
            },
        )
        call.system?.let { put("instructions", it) }
        if (call.tools.isNotEmpty()) {
            put("tools", toolsAsResponsesJson(call.tools))
        }
        when (model.toolChoice) {
            ToolChoice.FORCE -> put("tool_choice", "required")
            ToolChoice.NONE -> put("tool_choice", "none")
            else -> Unit
        }
        put("stream", true)
    }

    private fun inputContentToResponsesJson(
        content: List<LlmInputContent>,
    ): JsonArray = buildJsonArray {
        content.forEach {
            add(
                when (it) {
                    is LlmInputContent.Text -> buildJsonObject {
                        put("type", "input_text")
                        put("text", it.text)
                    }

                    is LlmInputContent.Image -> buildJsonObject {
                        put("type", "input_image")
                        put("image_url", it.url)
                        it.detail?.let { detail ->
                            put(
                                "detail",
                                when (detail) {
                                    ImageDetail.LOW -> "low"
                                    ImageDetail.HIGH -> "high"
                                },
                            )
                        }
                    }
                },
            )
        }
    }

    private fun reasoningToResponsesJson(
        reasoning: LlmOutputContent.Reasoning,
        index: Int,
    ): JsonObject {
        if (
            reasoning.sourceFormat == ModelApiFormat.RESPONSES &&
            reasoning.opaque?.string("type") == "reasoning"
        ) {
            return reasoning.opaque
        }

        return buildJsonObject {
            put("type", "reasoning")
            put("id", "cross_reasoning_$index")
            put(
                "summary",
                buildJsonArray {
                    if (reasoning.text.isNotEmpty()) {
                        add(
                            buildJsonObject {
                                put("type", "summary_text")
                                put("text", reasoning.text)
                            },
                        )
                    }
                },
            )
            reasoning.opaqueSignature()?.let {
                put("encrypted_content", it)
            }
        }
    }

    private fun parseFinalOutput(
        output: JsonArray,
    ): List<LlmOutputContent> = output.flatMap { element ->
        val item = element.asObjectOrNull() ?: return@flatMap emptyList()
        when (item.string("type")) {
            "message" -> (item["content"] as? JsonArray)
                .orEmpty()
                .mapNotNull { blockElement ->
                    val block = blockElement.asObjectOrNull()
                        ?: return@mapNotNull null
                    when (block.string("type")) {
                        "output_text" -> block.string("text")
                            ?.let(LlmOutputContent::Text)

                        "refusal" -> block.string("refusal")
                            ?.let(LlmOutputContent::Text)

                        else -> null
                    }
                }

            "reasoning" -> listOf(
                LlmOutputContent.Reasoning(
                    sourceFormat = format,
                    text = item.reasoningText(),
                    opaque = item,
                ),
            )

            "function_call" -> listOf(
                LlmOutputContent.ToolCall(
                    callId = item.string("call_id").orEmpty(),
                    name = item.string("name").orEmpty(),
                    arguments = json.parseArguments(
                        item.string("arguments").orEmpty(),
                    ),
                ),
            )

            else -> emptyList()
        }
    }

    private class ToolCallAccumulator {
        var callId: String = ""
        var name: String = ""
        val arguments = StringBuilder()
    }
}

class ResponsesStreamException(
    message: String,
) : RuntimeException(message)

private fun JsonElement.asObjectOrNull(): JsonObject? =
    this as? JsonObject

private fun JsonObject.string(key: String): String? =
    get(key)
        ?.takeUnless { it is JsonNull }
        ?.jsonPrimitive
        ?.contentOrNull

private fun JsonObject.int(key: String): Int? =
    get(key)?.jsonPrimitive?.intOrNull

private fun JsonObject.long(key: String): Long? =
    get(key)?.jsonPrimitive?.longOrNull

private fun JsonObject.reasoningText(): String {
    val content = textBlocks("content", "reasoning_text")
    return content.ifEmpty {
        textBlocks("summary", "summary_text")
    }
}

private fun JsonObject.textBlocks(
    key: String,
    type: String,
): String = (get(key) as? JsonArray)
    .orEmpty()
    .mapNotNull { element ->
        element.asObjectOrNull()
            ?.takeIf { it.string("type") == type }
            ?.string("text")
    }
    .joinToString("\n")
