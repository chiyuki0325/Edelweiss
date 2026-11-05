package ink.chyk.edelweiss.llm

import ink.chyk.edelweiss.llm.anthropic.AnthropicMessagesApi
import ink.chyk.edelweiss.llm.chat.ChatCompletionsApi
import ink.chyk.edelweiss.llm.responses.ResponsesApi
import ink.chyk.edelweiss.llm.transport.SseHttpTransport
import io.ktor.client.*
import io.ktor.client.engine.java.*
import io.ktor.client.plugins.contentnegotiation.*
import io.ktor.serialization.kotlinx.json.*
import kotlinx.serialization.json.Json
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

@Configuration(proxyBeanMethods = false)
class LlmConfiguration {
    @Bean
    fun llmJson(): Json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
    }

    @Bean(destroyMethod = "close")
    fun llmHttpClient(
        llmJson: Json,
    ): HttpClient = HttpClient(Java) {
        expectSuccess = false
        install(ContentNegotiation) {
            json(llmJson)
        }
    }

    @Bean
    fun sseHttpTransport(
        llmHttpClient: HttpClient,
    ): SseHttpTransport = SseHttpTransport(llmHttpClient)

    @Bean
    fun llmConcurrencyLimiter(): LlmConcurrencyLimiter = LlmConcurrencyLimiter()

    @Bean
    fun chatCompletionsApi(
        transport: SseHttpTransport,
        llmJson: Json,
        concurrencyLimiter: LlmConcurrencyLimiter,
    ): ChatCompletionsApi = ChatCompletionsApi(transport, llmJson, concurrencyLimiter)

    @Bean
    fun responsesApi(
        transport: SseHttpTransport,
        llmJson: Json,
        concurrencyLimiter: LlmConcurrencyLimiter,
    ): ResponsesApi = ResponsesApi(transport, llmJson, concurrencyLimiter)

    @Bean
    fun anthropicMessagesApi(
        transport: SseHttpTransport,
        llmJson: Json,
        concurrencyLimiter: LlmConcurrencyLimiter,
    ): AnthropicMessagesApi = AnthropicMessagesApi(transport, llmJson, concurrencyLimiter)
}
