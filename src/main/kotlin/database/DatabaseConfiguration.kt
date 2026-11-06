package ink.chyk.edelweiss.database

import ink.chyk.edelweiss.config.AppConfig
import ink.chyk.edelweiss.database.repos.ChatEventRepository
import ink.chyk.edelweiss.database.tables.ChatEventsTable
import org.jetbrains.exposed.v1.jdbc.Database
import org.jetbrains.exposed.v1.jdbc.SchemaUtils
import org.jetbrains.exposed.v1.jdbc.transactions.transaction
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
        val database = Database.connect(
            url = "jdbc:sqlite:$path",
            driver = "org.sqlite.JDBC",
        )
        transaction(database) {
            SchemaUtils.create(ChatEventsTable)
        }
        return database
    }

    @Bean
    fun chatEventRepository(database: Database): ChatEventRepository =
        ChatEventRepository(database)
}
