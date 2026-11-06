package ink.chyk.edelweiss.database.tables

import org.jetbrains.exposed.v1.core.Table

object ChatEventsTable : Table("chat_events") {
    val id = long("id").autoIncrement()
    val chatId = text("chat_id")
    val receivedAtMs = long("received_at_ms")
    val occurredAtMs = long("occurred_at_ms")
    val payload = text("payload")

    override val primaryKey = PrimaryKey(id)

    init {
        index(false, chatId, receivedAtMs, id)
    }
}
