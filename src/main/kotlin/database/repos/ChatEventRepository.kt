package ink.chyk.edelweiss.database.repos

import ink.chyk.edelweiss.adapter.models.ChatEvent
import ink.chyk.edelweiss.adapter.models.ChatEventPayload
import ink.chyk.edelweiss.database.tables.ChatEventsTable
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import org.jetbrains.exposed.v1.core.SortOrder
import org.jetbrains.exposed.v1.core.eq
import org.jetbrains.exposed.v1.core.greaterEq
import org.jetbrains.exposed.v1.jdbc.Database
import org.jetbrains.exposed.v1.jdbc.andWhere
import org.jetbrains.exposed.v1.jdbc.insert
import org.jetbrains.exposed.v1.jdbc.selectAll
import org.jetbrains.exposed.v1.jdbc.transactions.transaction
import kotlin.time.Instant

class ChatEventRepository(
    private val database: Database,
) {
    private val json = Json {
        encodeDefaults = true
        ignoreUnknownKeys = true
    }

    suspend fun append(event: ChatEvent): Long {
        val encodedPayload = json.encodeToString<ChatEventPayload>(event.payload)
        return withContext(Dispatchers.IO) {
            transaction(database) {
                ChatEventsTable.insert {
                    it[chatId] = event.chatId
                    it[receivedAtMs] = event.receivedAt.toEpochMilliseconds()
                    it[occurredAtMs] = event.occurredAt.toEpochMilliseconds()
                    it[payload] = encodedPayload
                }[ChatEventsTable.id]
            }
        }
    }

    suspend fun load(
        chatId: String,
        since: Instant? = null,
    ): List<ChatEvent> = withContext(Dispatchers.IO) {
        val rows = transaction(database) {
            val query = ChatEventsTable.selectAll()
                .where { ChatEventsTable.chatId eq chatId }
            if (since != null) {
                query.andWhere { ChatEventsTable.receivedAtMs greaterEq since.toEpochMilliseconds() }
            }
            query.orderBy(
                ChatEventsTable.receivedAtMs to SortOrder.ASC,
                ChatEventsTable.id to SortOrder.ASC,
            ).toList()
        }
        rows.map { row ->
            ChatEvent(
                chatId = row[ChatEventsTable.chatId],
                receivedAt = Instant.fromEpochMilliseconds(row[ChatEventsTable.receivedAtMs]),
                occurredAt = Instant.fromEpochMilliseconds(row[ChatEventsTable.occurredAtMs]),
                payload = json.decodeFromString<ChatEventPayload>(row[ChatEventsTable.payload]),
            )
        }
    }
}
