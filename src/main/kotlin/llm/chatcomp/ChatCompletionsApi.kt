package ink.chyk.edelweiss.llm.chat

import ink.chyk.edelweiss.config.ModelApiFormat
import ink.chyk.edelweiss.config.ModelConfig
import ink.chyk.edelweiss.config.ToolChoice
import ink.chyk.edelweiss.llm.*
import ink.chyk.edelweiss.llm.transport.SseHttpTransport
import io.ktor.http.*
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.serialization.json.*

class ChatCompletionsApi(
    private val transport: SseHttpTransport,
    private val json: Json,
    private val concurrencyLimiter: LlmConcurrencyLimiter,
) : LlmApi {
    override val format: ModelApiFormat = ModelApiFormat.CHAT_COMPLETIONS

    override fun execute(
        model: ModelConfig,
        call: LlmCall,
    ): Flow<LlmEvent> = concurrencyLimiter.execute(model) {
        streamChatCompletion(model, call)
    }

    fun streamChatCompletion(
        model: ModelConfig,
        call: LlmCall,
    ): Flow<LlmEvent> = flow {
        val requestBody = buildRequest(model, call)
        val text = StringBuilder()
        val reasoning = StringBuilder()
        val reasoningOpaque = StringBuilder()
        val toolCalls = mutableMapOf<Int, ToolCallAccumulator>()
        var finishReason: String? = null
        var usage = LlmUsage()

        transport.post(
            url = endpoint(model, "chat/completions"),
            timeoutSec = model.timeoutSec,
            headers = {
                append(HttpHeaders.Authorization, "Bearer ${model.apiKey}")
            },
            body = requestBody,
        ).collect { frame ->
            if (frame.data == "[DONE]") {
                return@collect
            }

            val chunk = json.parseToJsonElement(frame.data).jsonObject
            chunk["error"]?.let { error ->
                val message = (error as? JsonObject)?.string("message")
                    ?: error.toString()
                throw ChatCompletionsStreamException(message)
            }
            chunk["usage"]?.asObjectOrNull()?.let {
                usage = parseUsage(it, usage)
            }

            val choice = chunk["choices"]
                ?.asArrayOrNull()
                ?.firstOrNull()
                ?.asObjectOrNull()
                ?: return@collect
            choice.string("finish_reason")?.let {
                finishReason = it
            }
            val delta = choice["delta"]?.asObjectOrNull() ?: return@collect

            delta.string("content")?.takeIf(String::isNotEmpty)?.let {
                text.append(it)
                emit(LlmEvent.TextDelta(it))
            }

            val reasoningDelta = REASONING_FIELDS
                .mapNotNull(delta::string)
                .joinToString("")
            if (reasoningDelta.isNotEmpty()) {
                reasoning.append(reasoningDelta)
                emit(LlmEvent.ReasoningDelta(reasoningDelta))
            }
            delta.string("reasoning_opaque")?.let(reasoningOpaque::append)

            delta["tool_calls"]?.asArrayOrNull()?.forEach { element ->
                val toolCall = element.asObjectOrNull() ?: return@forEach
                val index = toolCall.int("index") ?: 0
                val function = toolCall["function"]?.asObjectOrNull()
                val callId = toolCall.string("id")
                val name = function?.string("name")
                val argumentsDelta = function?.string("arguments").orEmpty()
                val accumulator = toolCalls.getOrPut(index) {
                    ToolCallAccumulator()
                }
                callId?.let { accumulator.callId = it }
                name?.let(accumulator.name::append)
                accumulator.arguments.append(argumentsDelta)
                emit(
                    LlmEvent.ToolCallDelta(
                        index = index,
                        callId = callId,
                        name = name,
                        argumentsDelta = argumentsDelta,
                    ),
                )
            }
        }

        val content = buildList {
            if (reasoning.isNotEmpty() || reasoningOpaque.isNotEmpty()) {
                add(
                    LlmOutputContent.Reasoning(
                        sourceFormat = format,
                        text = reasoning.toString(),
                        opaque = reasoningOpaque
                            .takeIf(StringBuilder::isNotEmpty)
                            ?.let {
                                buildJsonObject {
                                    put("reasoning_opaque", it.toString())
                                }
                            },
                    ),
                )
            }
            if (text.isNotEmpty()) {
                add(LlmOutputContent.Text(text.toString()))
            }
            toolCalls.toSortedMap().values.forEach { toolCall ->
                add(
                    LlmOutputContent.ToolCall(
                        callId = toolCall.callId,
                        name = toolCall.name.toString(),
                        arguments = json.parseArguments(toolCall.arguments.toString()),
                    ),
                )
            }
        }
        emit(
            LlmEvent.Completed(
                LlmResult(
                    content = content,
                    usage = usage,
                    finishReason = finishReason,
                ),
            ),
        )
    }

    private fun buildRequest(
        model: ModelConfig,
        call: LlmCall,
    ): JsonObject = buildRequestBody(model.extraBody) {
        put("model", model.model)
        put(
            "messages",
            messagesToJson(call),
        )
        if (call.tools.isNotEmpty()) {
            put("tools", toolsAsChatJson(call.tools))
        }
        when (model.toolChoice) {
            ToolChoice.FORCE -> put("tool_choice", "required")
            ToolChoice.NONE -> put("tool_choice", "none")
            else -> Unit
        }
        put("stream", true)
        put(
            "stream_options",
            buildJsonObject {
                put("include_usage", true)
            },
        )
    }

    private fun messagesToJson(
        call: LlmCall,
    ): JsonArray = buildJsonArray {
        call.system?.let {
            add(
                buildJsonObject {
                    put("role", "system")
                    put("content", it)
                },
            )
        }

        val pendingImageMessages = mutableListOf<JsonObject>()
        fun flushPendingImages() {
            pendingImageMessages.forEach(::add)
            pendingImageMessages.clear()
        }

        call.messages.forEach { message ->
            if (message !is LlmMessage.ToolResult) {
                flushPendingImages()
                add(messageToJson(message))
                return@forEach
            }

            val textParts = message.content.filterIsInstance<LlmInputContent.Text>()
            val imageParts = message.content.filterIsInstance<LlmInputContent.Image>()
            val text = textParts.joinToString("\n") { it.text }
            add(
                buildJsonObject {
                    put("role", "tool")
                    put("tool_call_id", message.callId)
                    put(
                        "content",
                        text.ifEmpty {
                            if (imageParts.isEmpty()) {
                                ""
                            } else {
                                "[Refer to the image below for tool result ${message.callId}]"
                            }
                        },
                    )
                },
            )
            if (imageParts.isNotEmpty()) {
                pendingImageMessages += buildJsonObject {
                    put("role", "user")
                    put(
                        "content",
                        buildJsonArray {
                            add(
                                buildJsonObject {
                                    put("type", "text")
                                    put(
                                        "text",
                                        "(Images from tool result ${message.callId}:)",
                                    )
                                },
                            )
                            imageParts.forEach { add(imageToChatJson(it)) }
                        },
                    )
                }
            }
        }
        flushPendingImages()
    }

    private fun messageToJson(message: LlmMessage): JsonObject = when (message) {
        is LlmMessage.User -> buildJsonObject {
            put("role", "user")
            put("content", inputContentToChatJson(message.content))
        }

        is LlmMessage.Assistant -> buildJsonObject {
            put("role", "assistant")
            val text = message.content
                .filterIsInstance<LlmOutputContent.Text>()
                .joinToString("") { it.text }
            put("content", text)

            val reasoning = message.content
                .filterIsInstance<LlmOutputContent.Reasoning>()
            val reasoningText = reasoning.joinToString("") { it.text }
            if (reasoningText.isNotEmpty()) {
                put("reasoning_content", reasoningText)
            }
            reasoning
                .firstNotNullOfOrNull(LlmOutputContent.Reasoning::opaqueSignature)
                ?.let { put("reasoning_opaque", it) }

            val toolCalls = message.content.filterIsInstance<LlmOutputContent.ToolCall>()
            if (toolCalls.isNotEmpty()) {
                put(
                    "tool_calls",
                    buildJsonArray {
                        toolCalls.forEach { toolCall ->
                            add(
                                buildJsonObject {
                                    put("id", toolCall.callId)
                                    put("type", "function")
                                    put(
                                        "function",
                                        buildJsonObject {
                                            put("name", toolCall.name)
                                            put("arguments", toolCall.arguments.toString())
                                        },
                                    )
                                },
                            )
                        }
                    },
                )
            }
        }

        is LlmMessage.ToolResult -> error(
            "Tool results are encoded by messagesToJson",
        )
    }

    private fun inputContentToChatJson(content: List<LlmInputContent>): JsonElement {
        if (content.size == 1 && content.single() is LlmInputContent.Text) {
            return JsonPrimitive((content.single() as LlmInputContent.Text).text)
        }

        return buildJsonArray {
            content.forEach {
                add(
                    when (it) {
                        is LlmInputContent.Text -> buildJsonObject {
                            put("type", "text")
                            put("text", it.text)
                        }

                        is LlmInputContent.Image -> imageToChatJson(it)
                    },
                )
            }
        }
    }

    private fun imageToChatJson(
        image: LlmInputContent.Image,
    ): JsonObject = buildJsonObject {
        put("type", "image_url")
        put(
            "image_url",
            buildJsonObject {
                put("url", image.url)
                image.detail?.let { detail ->
                    put(
                        "detail",
                        when (detail) {
                            ImageDetail.LOW -> "low"
                            ImageDetail.HIGH -> "high"
                        },
                    )
                }
            },
        )
    }

    private fun parseUsage(
        value: JsonObject,
        previous: LlmUsage,
    ): LlmUsage {
        val details = value["prompt_tokens_details"]?.asObjectOrNull()
        return LlmUsage(
            inputTokens = value.long("prompt_tokens") ?: previous.inputTokens,
            outputTokens = value.long("completion_tokens") ?: previous.outputTokens,
            cacheCreationTokens = value.long("prompt_cache_miss_tokens")
                ?: previous.cacheCreationTokens,
            cacheReadTokens = value.long("prompt_cache_hit_tokens")
                ?: details?.long("cached_tokens")
                ?: previous.cacheReadTokens,
        )
    }

    private class ToolCallAccumulator {
        var callId: String = ""
        val name = StringBuilder()
        val arguments = StringBuilder()
    }

    private companion object {
        val REASONING_FIELDS = listOf(
            "reasoning_text",
            "reasoning_content",
            "reasoning",
        )
    }
}

class ChatCompletionsStreamException(
    message: String,
) : RuntimeException(message)

private fun JsonElement.asObjectOrNull(): JsonObject? =
    this as? JsonObject

private fun JsonElement.asArrayOrNull(): JsonArray? =
    this as? JsonArray

private fun JsonObject.string(key: String): String? =
    get(key)
        ?.takeUnless { it is JsonNull }
        ?.jsonPrimitive
        ?.contentOrNull

private fun JsonObject.int(key: String): Int? =
    get(key)?.jsonPrimitive?.intOrNull

private fun JsonObject.long(key: String): Long? =
    get(key)?.jsonPrimitive?.longOrNull
