package ink.chyk.edelweiss.config

import kotlinx.serialization.json.JsonObject

data class AppConfig(
    val models: Map<String, ModelConfig> = emptyMap(),
)

data class ModelConfig(
    val apiBaseUrl: String,
    val apiKey: String,
    val model: String,
    val apiFormat: ModelApiFormat = ModelApiFormat.CHAT_COMPLETIONS,
    val maxImagesAllowed: Int? = null,
    val timeoutSec: Long? = null,
    val maxConcurrency: Int? = null,
    val extraBody: JsonObject? = null,
    val localForceMaxRetries: Int = 3,
    val toolChoice: ToolChoice? = null,
) {
    init {
        require(maxConcurrency == null || maxConcurrency > 0) {
            "maxConcurrency 必须为正整数"
        }
        require(localForceMaxRetries >= 0) {
            "localForceMaxRetries 必须为非负整数"
        }
    }

    override fun toString(): String =
        "ModelConfig(" +
            "apiBaseUrl=$apiBaseUrl, " +
            "apiKey=***, " +
            "model=$model, " +
            "apiFormat=$apiFormat, " +
            "maxImagesAllowed=$maxImagesAllowed, " +
            "timeoutSec=$timeoutSec, " +
            "maxConcurrency=$maxConcurrency, " +
            "extraBodyKeys=${extraBody?.keys}, " +
            "localForceMaxRetries=$localForceMaxRetries, " +
            "toolChoice=$toolChoice" +
            ")"
}

enum class ModelApiFormat {
    CHAT_COMPLETIONS,
    RESPONSES,
    ANTHROPIC_MESSAGES,
}

enum class ToolChoice {
    FORCE,
    LOCAL_FORCE,
    NONE,
    LOCAL_NONE,
}
