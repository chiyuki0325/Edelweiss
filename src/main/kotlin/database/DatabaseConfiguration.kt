package ink.chyk.edelweiss.database

import ink.chyk.edelweiss.config.AppConfig
import org.jetbrains.exposed.v1.jdbc.Database
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import kotlin.io.path.Path
import kotlin.io.path.createDirectories

@Configuration(proxyBeanMethods = false)
class DatabaseConfiguration {
    @Bean
    fun database(config: AppConfig): Database {
        val path = Path(config.database.path).toAbsolutePath()
        path.parent.createDirectories()
        return Database.connect(
            url = "jdbc:sqlite:$path",
            driver = "org.sqlite.JDBC",
        )
    }
}
