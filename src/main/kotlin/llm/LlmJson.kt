package ink.chyk.edelweiss.llm

import ink.chyk.edelweiss.config.ModelApiFormat
import ink.chyk.edelweiss.config.ModelConfig
import kotlinx.serialization.json.*

internal fun endpoint(
    model: ModelConfig,
    path: String,
): String = "${model.apiBaseUrl.trimEnd('/')}/$path"

internal fun buildRequestBody(
    extraBody: JsonObject?,
    block: JsonObjectBuilder.() -> Unit,
): JsonObject = buildJsonObject {
    extraBody?.forEach { (key, value) -> put(key, value) }
    block()
}

internal fun toolsAsChatJson(tools: List<LlmTool>): JsonArray = buildJsonArray {
    tools.forEach { tool ->
        add(
            buildJsonObject {
                put("type", "function")
                put(
                    "function",
                    buildJsonObject {
                        put("name", tool.name)
                        tool.description?.let { put("description", it) }
                        put("parameters", tool.parameters)
                    },
                )
            },
        )
    }
}

internal fun toolsAsResponsesJson(tools: List<LlmTool>): JsonArray = buildJsonArray {
    tools.forEach { tool ->
        add(
            buildJsonObject {
                put("type", "function")
                put("name", tool.name)
                tool.description?.let { put("description", it) }
                put("parameters", tool.parameters)
                put("strict", false)
            },
        )
    }
}

internal fun toolsAsAnthropicJson(tools: List<LlmTool>): JsonArray = buildJsonArray {
    tools.forEach { tool ->
        add(
            buildJsonObject {
                put("name", tool.name)
                tool.description?.let { put("description", it) }
                put("input_schema", tool.parameters)
            },
        )
    }
}

internal fun Json.parseArguments(raw: String): JsonElement =
    runCatching { parseToJsonElement(raw) }
        .getOrElse { JsonPrimitive(raw) }

internal fun LlmOutputContent.Reasoning.opaqueSignature(): String? {
    signature?.let { return it }
    val field = when (sourceFormat) {
        ModelApiFormat.CHAT_COMPLETIONS -> "reasoning_opaque"
        ModelApiFormat.RESPONSES -> "encrypted_content"
        ModelApiFormat.ANTHROPIC_MESSAGES -> "data"
    }
    return (opaque?.get(field) as? JsonPrimitive)?.content
}
