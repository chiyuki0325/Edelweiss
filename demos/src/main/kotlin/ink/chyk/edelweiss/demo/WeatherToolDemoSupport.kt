package ink.chyk.edelweiss.demo

import ink.chyk.edelweiss.config.ModelConfig
import ink.chyk.edelweiss.llm.LlmApi
import ink.chyk.edelweiss.llm.LlmCall
import ink.chyk.edelweiss.llm.LlmEvent
import ink.chyk.edelweiss.llm.LlmInputContent
import ink.chyk.edelweiss.llm.LlmMessage
import ink.chyk.edelweiss.llm.LlmOutputContent
import ink.chyk.edelweiss.llm.LlmResult
import ink.chyk.edelweiss.llm.LlmTool
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.nio.file.Files
import java.nio.file.Path

private const val MAX_TOOL_ROUNDS = 5

internal suspend fun runWeatherToolDemo(
    api: LlmApi,
    model: ModelConfig,
) {
    val messages = mutableListOf<LlmMessage>(
        LlmMessage.User(
            content = listOf(
                LlmInputContent.Text(
                    "请调用天气工具查询沈阳现在的天气，再根据工具结果回答。",
                ),
            ),
        ),
    )

    repeat(MAX_TOOL_ROUNDS) { round ->
        println("=== round ${round + 1} ===")
        var completed: LlmResult? = null
        api.execute(
            model = model,
            call = LlmCall(
                messages = messages,
                tools = listOf(weatherTool),
            ),
        ).collect { event ->
            println(event)
            if (event is LlmEvent.Completed) {
                completed = event.result
            }
        }

        val result = checkNotNull(completed) {
            "LLM stream ended without a Completed event"
        }
        val toolCalls = result.content.filterIsInstance<LlmOutputContent.ToolCall>()
        if (toolCalls.isEmpty()) {
            return
        }

        messages += LlmMessage.Assistant(result.content)
        toolCalls.forEach { toolCall ->
            val output = executeMockTool(toolCall)
            println("MockToolResult(callId=${toolCall.callId}, output=$output)")
            messages += LlmMessage.ToolResult(
                callId = toolCall.callId,
                content = listOf(LlmInputContent.Text(output)),
            )
        }
    }

    error("Model exceeded $MAX_TOOL_ROUNDS tool-call rounds")
}

private val weatherTool = LlmTool(
    name = "get_weather",
    description = "查询指定地点当前的天气。",
    parameters = buildJsonObject {
        put("type", "object")
        put(
            "properties",
            buildJsonObject {
                put(
                    "location",
                    buildJsonObject {
                        put("type", "string")
                        put("description", "要查询的城市或地点名称。")
                    },
                )
            },
        )
        put(
            "required",
            buildJsonArray {
                add(JsonPrimitive("location"))
            },
        )
        put("additionalProperties", false)
    },
)

private fun executeMockTool(toolCall: LlmOutputContent.ToolCall): String {
    require(toolCall.name == weatherTool.name) {
        "Unknown tool: ${toolCall.name}"
    }
    val arguments = toolCall.arguments as? JsonObject
        ?: error("get_weather arguments must be a JSON object")
    val location = arguments["location"]
        ?.jsonPrimitive
        ?.contentOrNull
        ?: error("get_weather requires location")
    return mockWeather(location)
}

private fun mockWeather(location: String): String = buildJsonObject {
    put("location", location)
    put("weather", "晴")
    put("temperatureCelsius", 18)
    put("humidityPercent", 42)
    put("source", "mock")
}.toString()

internal fun readDeepSeekToken(): String {
    val credentialHome = System.getenv("CODEX_HOME")
        ?.let(Path::of)
        ?: Path.of(System.getProperty("user.home"), ".codex")
    val tokenFile = credentialHome.resolve("deepseek-token")
    if (Files.isRegularFile(tokenFile)) {
        Files.readString(tokenFile)
            .trim()
            .takeIf(String::isNotEmpty)
            ?.let { return it }
    }

    return requireNotNull(
        System.getenv("DEEPSEEK_API_KEY")
            ?.trim()
            ?.takeIf(String::isNotEmpty),
    ) {
        "DeepSeek credential is unavailable: set DEEPSEEK_API_KEY or write $tokenFile"
    }
}
