package ink.chyk.edelweiss.adapter.models

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlin.time.Instant

@Serializable
data class ChatEvent(
    // telegram:-100xxx
    // onebot:xxx
    val chatId: String,
    val receivedAt: Instant,
    val occurredAt: Instant,
    val payload: ChatEventPayload,
)

@Serializable
sealed interface ChatEventPayload {
    @Serializable
    @SerialName("message")
    data class Message(
        val messageId: String,
        val content: List<ChatContent>,
        val sender: ChatUser? = null,
        val attachments: List<ChatAttachment> = emptyList(),
        val replyToMessageId: String? = null,
        val replyQuoteText: String? = null,
        val forwardInfo: ChatForwardInfo? = null,
        val isMyself: Boolean = false,
        val isSelfSent: Boolean = false,
        val isAssociatedChannelPost: Boolean = false,
    ) : ChatEventPayload

    @Serializable
    @SerialName("blocked_message")
    data class BlockedMessage(
        val messageId: String,
    ) : ChatEventPayload

    @Serializable
    @SerialName("edit")
    data class Edit(
        val messageId: String,
        val content: List<ChatContent>,
        val attachments: List<ChatAttachment>,
        val sender: ChatUser? = null,
    ) : ChatEventPayload

    @Serializable
    @SerialName("delete")
    data class Delete(
        val messageIds: List<String>,
    ) : ChatEventPayload

    @Serializable
    @SerialName("reaction")
    data class Reaction(
        val messageId: String,
        val emoji: String,
        val count: Int,
        val sender: ChatUser? = null,
    ) : ChatEventPayload

    @Serializable
    @SerialName("service")
    data class Service(
        val action: ChatServiceAction,
        val actor: ChatUser? = null,
    ) : ChatEventPayload
}

@Serializable
data class ChatUser(
    val id: String,
    val displayName: String,
    val isBot: Boolean,
    val username: String? = null,
)

@Serializable
data class ChatForwardInfo(
    val fromUserId: String? = null,
    val fromChatId: String? = null,
    val sender: ChatUser? = null,
    val senderName: String? = null,
    val forwardedAt: Instant? = null,
)
