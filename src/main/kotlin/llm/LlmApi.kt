package ink.chyk.edelweiss.llm

import ink.chyk.edelweiss.config.ModelApiFormat
import ink.chyk.edelweiss.config.ModelConfig
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

interface LlmApi {
    val format: ModelApiFormat

    fun execute(
        model: ModelConfig,
        call: LlmCall,
    ): Flow<LlmEvent>
}

data class LlmCall(
    val messages: List<LlmMessage>,
    val system: String? = null,
    val tools: List<LlmTool> = emptyList(),
)

sealed interface LlmMessage {
    data class User(
        val content: List<LlmInputContent>,
    ) : LlmMessage

    data class Assistant(
        val content: List<LlmOutputContent>,
    ) : LlmMessage

    data class ToolResult(
        val callId: String,
        val content: List<LlmInputContent>,
    ) : LlmMessage
}

sealed interface LlmInputContent {
    data class Text(
        val text: String,
    ) : LlmInputContent

    data class Image(
        val url: String,
        val detail: ImageDetail? = null,
    ) : LlmInputContent
}

enum class ImageDetail {
    LOW,
    HIGH,
}

sealed interface LlmOutputContent {
    data class Text(
        val text: String,
    ) : LlmOutputContent

    data class Reasoning(
        val sourceFormat: ModelApiFormat,
        val text: String,
        val signature: String? = null,
        val opaque: JsonObject? = null,
    ) : LlmOutputContent

    data class ToolCall(
        val callId: String,
        val name: String,
        val arguments: JsonElement,
    ) : LlmOutputContent
}

data class LlmTool(
    val name: String,
    val parameters: JsonObject,
    val description: String? = null,
)

sealed interface LlmEvent {
    data class TextDelta(
        val text: String,
    ) : LlmEvent

    data class ReasoningDelta(
        val text: String,
    ) : LlmEvent

    data class ToolCallDelta(
        val index: Int,
        val callId: String? = null,
        val name: String? = null,
        val argumentsDelta: String = "",
    ) : LlmEvent

    data class Completed(
        val result: LlmResult,
    ) : LlmEvent
}

data class LlmResult(
    val content: List<LlmOutputContent>,
    val usage: LlmUsage = LlmUsage(),
    val finishReason: String? = null,
)

data class LlmUsage(
    val inputTokens: Long = 0,
    val outputTokens: Long = 0,
    val cacheCreationTokens: Long? = null,
    val cacheReadTokens: Long? = null,
)
