package ink.chyk.edelweiss.demo

import ink.chyk.edelweiss.config.ModelApiFormat
import ink.chyk.edelweiss.config.ModelConfig
import ink.chyk.edelweiss.llm.LlmConfiguration
import ink.chyk.edelweiss.llm.anthropic.AnthropicMessagesApi
import kotlinx.coroutines.runBlocking
import org.springframework.context.annotation.AnnotationConfigApplicationContext

fun main() = runBlocking {
    AnnotationConfigApplicationContext(LlmConfiguration::class.java).use { context ->
        val api = context.getBean(AnthropicMessagesApi::class.java)
        val model = ModelConfig(
            apiBaseUrl = "https://api.deepseek.com/anthropic/v1",
            apiKey = readDeepSeekToken(),
            model = "deepseek-flash",
            apiFormat = ModelApiFormat.ANTHROPIC_MESSAGES,
        )
        runWeatherToolDemo(api, model)
    }
}
