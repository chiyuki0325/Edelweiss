package ink.chyk.edelweiss.config

import com.sksamuel.hoplite.ConfigLoaderBuilder
import com.sksamuel.hoplite.addPathSource
import java.nio.file.Path
import kotlin.io.path.Path

private const val CONFIG_ENVIRONMENT_VARIABLE = "EDELWEISS_CONFIG"
private const val DEFAULT_CONFIG_PATH = "config.yaml"

object AppConfigLoader {
    fun load(): AppConfig {
        val source = resolveSource()

        return ConfigLoaderBuilder.default()
            .addPathSource(source.path, optional = source.optional)
            .addNodeTransformer(ProfileNodeTransformer)
            .addDecoder(JsonObjectDecoder)
            .allowEmptyConfigFiles()
            .strict()
            .build()
            .loadConfigOrThrow()
    }

    private fun resolveSource(): ConfigSource {
        val environmentPath = System.getenv(CONFIG_ENVIRONMENT_VARIABLE)
            ?.takeIf { it.isNotBlank() }
        if (environmentPath != null) {
            return ConfigSource(Path(environmentPath), optional = false)
        }

        return ConfigSource(Path(DEFAULT_CONFIG_PATH), optional = true)
    }

    private data class ConfigSource(
        val path: Path,
        val optional: Boolean,
    )
}
