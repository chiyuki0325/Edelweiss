package ink.chyk.edelweiss.adapter.models

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
sealed interface ChatContent {
    @Serializable
    @SerialName("text")
    data class Text(
        val text: String,
    ) : ChatContent

    @Serializable
    @SerialName("code")
    data class Code(
        val text: String,
    ) : ChatContent

    @Serializable
    @SerialName("pre")
    data class Pre(
        val text: String,
        val language: String? = null,
    ) : ChatContent

    @Serializable
    @SerialName("bold")
    data class Bold(
        val children: List<ChatContent>,
    ) : ChatContent

    @Serializable
    @SerialName("italic")
    data class Italic(
        val children: List<ChatContent>,
    ) : ChatContent

    @Serializable
    @SerialName("underline")
    data class Underline(
        val children: List<ChatContent>,
    ) : ChatContent

    @Serializable
    @SerialName("strikethrough")
    data class Strikethrough(
        val children: List<ChatContent>,
    ) : ChatContent

    @Serializable
    @SerialName("spoiler")
    data class Spoiler(
        val children: List<ChatContent>,
    ) : ChatContent

    @Serializable
    @SerialName("blockquote")
    data class Blockquote(
        val children: List<ChatContent>,
    ) : ChatContent

    @Serializable
    @SerialName("link")
    data class Link(
        val url: String,
        val children: List<ChatContent>,
    ) : ChatContent

    @Serializable
    @SerialName("link_preview")
    data class LinkPreview(
        val url: String,
        val displayUrl: String? = null,
        val siteName: String? = null,
        val title: String? = null,
        val description: String? = null,
        val kind: String? = null,
    ) : ChatContent

    @Serializable
    @SerialName("mention")
    data class Mention(
        val children: List<ChatContent>,
        val userId: String? = null,
    ) : ChatContent

    @Serializable
    @SerialName("custom_emoji")
    data class CustomEmoji(
        val customEmojiId: String,
        val children: List<ChatContent>,
        val altText: String? = null,
        val altTextError: String? = null,
        val stickerSetName: String? = null,
    ) : ChatContent

    @Serializable
    @SerialName("face")
    data class Face(
        val faceId: String,
        val text: String,
    ) : ChatContent

    @Serializable
    @SerialName("forward")
    data class Forward(
        val messages: List<ChatForwardedMessage>,
    ) : ChatContent

    @Serializable
    @SerialName("rich")
    data class Rich(
        val text: String,
    ) : ChatContent
}

@Serializable
data class ChatForwardedMessage(
    val senderName: String,
    val content: List<ChatContent>,
    val senderId: String? = null,
)
