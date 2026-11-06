package ink.chyk.edelweiss.adapter.models

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
sealed interface ChatServiceAction {
    @Serializable
    @SerialName("members_joined")
    data class MembersJoined(
        val members: List<ChatUser>,
    ) : ChatServiceAction

    @Serializable
    @SerialName("member_left")
    data class MemberLeft(
        val member: ChatUser,
    ) : ChatServiceAction

    @Serializable
    @SerialName("chat_renamed")
    data class ChatRenamed(
        val newTitle: String,
    ) : ChatServiceAction

    @Serializable
    @SerialName("chat_photo_changed")
    data object ChatPhotoChanged : ChatServiceAction

    @Serializable
    @SerialName("chat_photo_deleted")
    data object ChatPhotoDeleted : ChatServiceAction

    @Serializable
    @SerialName("message_pinned")
    data class MessagePinned(
        val messageId: String,
    ) : ChatServiceAction
}
