package ink.chyk.edelweiss.llm

import ink.chyk.edelweiss.config.ModelApiFormat
import ink.chyk.edelweiss.config.ModelConfig
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import java.util.concurrent.ConcurrentHashMap

class LlmConcurrencyLimiter {
    private val semaphores = ConcurrentHashMap<ConcurrencyKey, Semaphore>()

    fun execute(
        model: ModelConfig,
        request: () -> Flow<LlmEvent>,
    ): Flow<LlmEvent> = flow {
        val maxConcurrency = model.maxConcurrency
        if (maxConcurrency == null) {
            emitAll(request())
            return@flow
        }

        semaphores.computeIfAbsent(model.concurrencyKey()) {
            Semaphore(maxConcurrency)
        }.withPermit {
            emitAll(request())
        }
    }

    private data class ConcurrencyKey(
        val apiFormat: ModelApiFormat,
        val apiBaseUrl: String,
        val model: String,
        val apiKey: String,
        val maxConcurrency: Int,
    )

    private fun ModelConfig.concurrencyKey(): ConcurrencyKey = ConcurrencyKey(
        apiFormat = apiFormat,
        apiBaseUrl = apiBaseUrl.trimEnd('/'),
        model = model,
        apiKey = apiKey,
        maxConcurrency = requireNotNull(maxConcurrency),
    )
}
