package ink.chyk.edelweiss.llm.anthropic

import ink.chyk.edelweiss.config.ModelApiFormat
import ink.chyk.edelweiss.config.ModelConfig
import ink.chyk.edelweiss.config.ToolChoice
import ink.chyk.edelweiss.llm.*
import ink.chyk.edelweiss.llm.transport.SseHttpTransport
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.serialization.json.*

class AnthropicMessagesApi(
    private val transport: SseHttpTransport,
    private val json: Json,
    private val concurrencyLimiter: LlmConcurrencyLimiter,
) : LlmApi {
    override val format: ModelApiFormat = ModelApiFormat.ANTHROPIC_MESSAGES

    override fun execute(
        model: ModelConfig,
        call: LlmCall,
    ): Flow<LlmEvent> = concurrencyLimiter.execute(model) {
        streamMessage(model, call)
    }

    fun streamMessage(
        model: ModelConfig,
        call: LlmCall,
    ): Flow<LlmEvent> = flow {
        val blocks = mutableMapOf<Int, BlockAccumulator>()
        var usage = LlmUsage()
        var stopReason: String? = null

        transport.post(
            url = endpoint(model, "messages"),
            timeoutSec = model.timeoutSec,
            headers = {
                append("x-api-key", model.apiKey)
                append("anthropic-version", "2023-06-01")
                append("anthropic-beta", "prompt-caching-2024-07-31")
            },
            body = buildRequest(model, call),
        ).collect { frame ->
            if (frame.data == "[DONE]") {
                return@collect
            }
            val event = json.parseToJsonElement(frame.data).asObjectOrNull()
                ?: return@collect
            when (event.string("type") ?: frame.event) {
                "message_start" -> {
                    val initialUsage = event["message"]
                        ?.asObjectOrNull()
                        ?.get("usage")
                        ?.asObjectOrNull()
                    if (initialUsage != null) {
                        usage = usage.merge(initialUsage)
                    }
                }

                "content_block_start" -> {
                    val index = event.int("index") ?: 0
                    val block = event["content_block"]?.asObjectOrNull()
                        ?: return@collect
                    val accumulator = BlockAccumulator(
                        type = block.string("type").orEmpty(),
                        callId = block.string("id"),
                        name = block.string("name"),
                        text = StringBuilder(
                            block.string("text")
                                ?: block.string("thinking")
                                ?: "",
                        ),
                        signature = StringBuilder(block.string("signature").orEmpty()),
                        opaque = block.takeIf {
                            it.string("type") == "redacted_thinking"
                        },
                    )
                    blocks[index] = accumulator
                    if (accumulator.type == "tool_use") {
                        emit(
                            LlmEvent.ToolCallDelta(
                                index = index,
                                callId = accumulator.callId,
                                name = accumulator.name,
                            ),
                        )
                    }
                }

                "content_block_delta" -> {
                    val index = event.int("index") ?: 0
                    val delta = event["delta"]?.asObjectOrNull()
                        ?: return@collect
                    val block = blocks.getOrPut(index) {
                        BlockAccumulator(type = "")
                    }
                    when (delta.string("type")) {
                        "text_delta" -> {
                            val value = delta.string("text").orEmpty()
                            block.text.append(value)
                            emit(LlmEvent.TextDelta(value))
                        }

                        "thinking_delta" -> {
                            val value = delta.string("thinking").orEmpty()
                            block.text.append(value)
                            emit(LlmEvent.ReasoningDelta(value))
                        }

                        "signature_delta" -> {
                            block.signature.append(delta.string("signature").orEmpty())
                        }

                        "input_json_delta" -> {
                            val value = delta.string("partial_json").orEmpty()
                            block.arguments.append(value)
                            emit(
                                LlmEvent.ToolCallDelta(
                                    index = index,
                                    argumentsDelta = value,
                                ),
                            )
                        }
                    }
                }

                "message_delta" -> {
                    stopReason = event["delta"]
                        ?.asObjectOrNull()
                        ?.string("stop_reason")
                    event["usage"]?.asObjectOrNull()?.let {
                        usage = usage.merge(it)
                    }
                }

                "error" -> {
                    val error = event["error"]?.asObjectOrNull()
                    throw AnthropicStreamException(
                        error?.string("type"),
                        error?.string("message") ?: "Anthropic Messages API stream failed",
                    )
                }
            }
        }

        val content = blocks.toSortedMap().values.mapNotNull { block ->
            when (block.type) {
                "text" -> LlmOutputContent.Text(block.text.toString())
                "thinking" -> LlmOutputContent.Reasoning(
                    sourceFormat = format,
                    text = block.text.toString(),
                    signature = block.signature
                        .takeIf(StringBuilder::isNotEmpty)
                        ?.toString(),
                )

                "redacted_thinking" -> LlmOutputContent.Reasoning(
                    sourceFormat = format,
                    text = "",
                    opaque = block.opaque,
                )

                "tool_use" -> LlmOutputContent.ToolCall(
                    callId = block.callId.orEmpty(),
                    name = block.name.orEmpty(),
                    arguments = json.parseArguments(block.arguments.toString()),
                )

                else -> null
            }
        }
        emit(
            LlmEvent.Completed(
                LlmResult(
                    content = content,
                    usage = usage,
                    finishReason = stopReason,
                ),
            ),
        )
    }

    private fun buildRequest(
        model: ModelConfig,
        call: LlmCall,
    ): JsonObject = buildRequestBody(model.extraBody) {
        put("model", model.model)
        if (model.extraBody?.containsKey("max_tokens") != true) {
            put("max_tokens", DEFAULT_MAX_TOKENS)
        }
        call.system?.let {
            put(
                "system",
                buildJsonArray {
                    add(
                        buildJsonObject {
                            put("type", "text")
                            put("text", it)
                            put("cache_control", ephemeralCacheControl())
                        },
                    )
                },
            )
        }
        put(
            "messages",
            withMessageCacheBreakpoint(messagesToJson(call.messages)),
        )
        if (call.tools.isNotEmpty()) {
            val tools = toolsAsAnthropicJson(call.tools)
            put(
                "tools",
                JsonArray(
                    tools.mapIndexed { index, tool ->
                        if (index != tools.lastIndex) {
                            tool
                        } else {
                            buildJsonObject {
                                tool.jsonObject.forEach { (key, value) ->
                                    put(key, value)
                                }
                                put("cache_control", ephemeralCacheControl())
                            }
                        }
                    },
                ),
            )
        }
        when (model.toolChoice) {
            ToolChoice.FORCE -> put(
                "tool_choice",
                buildJsonObject {
                    put("type", "any")
                },
            )

            ToolChoice.NONE -> put(
                "tool_choice",
                buildJsonObject {
                    put("type", "none")
                },
            )

            else -> Unit
        }
        put("stream", true)
    }

    private fun withMessageCacheBreakpoint(
        messages: JsonArray,
    ): JsonArray {
        if (messages.isEmpty()) {
            return messages
        }

        val mutableMessages = messages.map(JsonElement::jsonObject).toMutableList()
        val startIndex = if (mutableMessages.size >= 2) {
            mutableMessages.lastIndex - 1
        } else {
            mutableMessages.lastIndex
        }

        for (messageIndex in startIndex downTo 0) {
            val message = mutableMessages[messageIndex]
            val content = message["content"] as? JsonArray ?: continue
            for (blockIndex in content.lastIndex downTo 0) {
                val block = content[blockIndex].jsonObject
                if (block.string("type") in NON_CACHEABLE_BLOCK_TYPES) {
                    continue
                }

                val cachedBlock = buildJsonObject {
                    block.forEach { (key, value) -> put(key, value) }
                    put("cache_control", ephemeralCacheControl())
                }
                mutableMessages[messageIndex] = buildJsonObject {
                    message.forEach { (key, value) -> put(key, value) }
                    put(
                        "content",
                        JsonArray(
                            content.mapIndexed { index, element ->
                                if (index == blockIndex) cachedBlock else element
                            },
                        ),
                    )
                }
                return JsonArray(mutableMessages)
            }
        }
        return messages
    }

    private fun ephemeralCacheControl(): JsonObject = buildJsonObject {
        put("type", "ephemeral")
    }

    private fun messagesToJson(
        messages: List<LlmMessage>,
    ): JsonArray {
        val idRemap = buildToolIdRemap(messages)
        val merged = mutableListOf<JsonObject>()
        messages.forEach { message ->
            val encoded = messageToJson(message, idRemap)
            val previous = merged.lastOrNull()
            if (
                previous == null ||
                previous.string("role") != encoded.string("role")
            ) {
                merged += encoded
                return@forEach
            }

            val previousContent = previous["content"] as? JsonArray
                ?: JsonArray(emptyList())
            val nextContent = encoded["content"] as? JsonArray
                ?: JsonArray(emptyList())
            merged[merged.lastIndex] = buildJsonObject {
                previous.forEach { (key, value) -> put(key, value) }
                put(
                    "content",
                    buildJsonArray {
                        previousContent.forEach(::add)
                        nextContent.forEach(::add)
                    },
                )
            }
        }
        return JsonArray(merged)
    }

    private fun buildToolIdRemap(
        messages: List<LlmMessage>,
    ): Map<String, String> {
        val result = mutableMapOf<String, String>()
        val used = mutableSetOf<String>()

        fun assign(id: String) {
            if (id in result) {
                return
            }
            val base = id.replace(INVALID_TOOL_ID_CHARACTER, "_")
                .ifEmpty { "id" }
            var candidate = base
            var suffix = 2
            while (!used.add(candidate)) {
                candidate = "${base}_${suffix++}"
            }
            result[id] = candidate
        }

        messages.forEach { message ->
            when (message) {
                is LlmMessage.Assistant -> message.content
                    .filterIsInstance<LlmOutputContent.ToolCall>()
                    .forEach { assign(it.callId) }

                is LlmMessage.ToolResult -> assign(message.callId)
                is LlmMessage.User -> Unit
            }
        }
        return result
    }

    private fun messageToJson(
        message: LlmMessage,
        idRemap: Map<String, String>,
    ): JsonObject = when (message) {
        is LlmMessage.User -> buildJsonObject {
            put("role", "user")
            put(
                "content",
                buildJsonArray {
                    message.content.forEach { add(inputContentToAnthropicJson(it)) }
                },
            )
        }

        is LlmMessage.Assistant -> buildJsonObject {
            put("role", "assistant")
            put(
                "content",
                buildJsonArray {
                    message.content.forEach { content ->
                        add(
                            when (content) {
                                is LlmOutputContent.Text -> buildJsonObject {
                                    put("type", "text")
                                    put("text", content.text)
                                }

                                is LlmOutputContent.Reasoning ->
                                    if (
                                        content.sourceFormat == ModelApiFormat.ANTHROPIC_MESSAGES &&
                                        content.opaque != null
                                    ) {
                                        content.opaque
                                    } else {
                                        buildJsonObject {
                                            put("type", "thinking")
                                            put("thinking", content.text)
                                            content.opaqueSignature()?.let {
                                                put("signature", it)
                                            }
                                        }
                                    }

                                is LlmOutputContent.ToolCall -> buildJsonObject {
                                    put("type", "tool_use")
                                    put("id", idRemap[content.callId] ?: content.callId)
                                    put("name", content.name)
                                    put(
                                        "input",
                                        content.arguments as? JsonObject
                                            ?: JsonObject(emptyMap()),
                                    )
                                }
                            },
                        )
                    }
                },
            )
        }

        is LlmMessage.ToolResult -> buildJsonObject {
            put("role", "user")
            put(
                "content",
                buildJsonArray {
                    add(
                        buildJsonObject {
                            put("type", "tool_result")
                            put(
                                "tool_use_id",
                                idRemap[message.callId] ?: message.callId,
                            )
                            put(
                                "content",
                                buildJsonArray {
                                    message.content.forEach {
                                        add(inputContentToAnthropicJson(it))
                                    }
                                },
                            )
                        },
                    )
                },
            )
        }
    }

    private fun inputContentToAnthropicJson(
        content: LlmInputContent,
    ): JsonObject = when (content) {
        is LlmInputContent.Text -> buildJsonObject {
            put("type", "text")
            put("text", content.text)
        }

        is LlmInputContent.Image -> buildJsonObject {
            put("type", "image")
            put("source", imageSource(content.url))
        }
    }

    private fun imageSource(url: String): JsonObject {
        val match = DATA_URL.matchEntire(url)
        if (match != null) {
            return buildJsonObject {
                put("type", "base64")
                put("media_type", match.groupValues[1])
                put("data", match.groupValues[2])
            }
        }

        return buildJsonObject {
            put("type", "url")
            put("url", url)
        }
    }

    private fun LlmUsage.merge(value: JsonObject): LlmUsage = copy(
        inputTokens = value.long("input_tokens") ?: inputTokens,
        outputTokens = value.long("output_tokens") ?: outputTokens,
        cacheCreationTokens = value.long("cache_creation_input_tokens")
            ?: cacheCreationTokens,
        cacheReadTokens = value.long("cache_read_input_tokens")
            ?: cacheReadTokens,
    )

    private data class BlockAccumulator(
        val type: String,
        val callId: String? = null,
        val name: String? = null,
        val text: StringBuilder = StringBuilder(),
        val signature: StringBuilder = StringBuilder(),
        val arguments: StringBuilder = StringBuilder(),
        val opaque: JsonObject? = null,
    )

    private companion object {
        const val DEFAULT_MAX_TOKENS = 8192
        val DATA_URL = Regex("^data:([^;,]+);base64,(.+)$")
        val INVALID_TOOL_ID_CHARACTER = Regex("[^a-zA-Z0-9_-]")
        val NON_CACHEABLE_BLOCK_TYPES = setOf(
            "thinking",
            "redacted_thinking",
        )
    }
}

class AnthropicStreamException(
    type: String?,
    message: String,
) : RuntimeException(
    if (type == null) message else "$type: $message",
)

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
