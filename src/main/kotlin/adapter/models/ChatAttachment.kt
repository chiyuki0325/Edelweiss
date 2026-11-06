package ink.chyk.edelweiss.adapter.models

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlin.time.Duration

@Serializable
data class ChatAttachment(
    val type: ChatAttachmentType,
    val mimeType: String? = null,
    val fileName: String? = null,
    val width: Int? = null,
    val height: Int? = null,
    val duration: Duration? = null,
    val thumbnailWebp: String? = null,
    val animationHash: String? = null,
    val stickerSetId: String? = null,
    val stickerSetName: String? = null,
    val altText: String? = null,
    val imageId: String? = null,
    val fileRef: String? = null,
)

@Serializable
enum class ChatAttachmentType {
    @SerialName("photo")
    PHOTO,
    @SerialName("sticker")
    STICKER,
    @SerialName("animation")
    ANIMATION,
    @SerialName("video")
    VIDEO,
    @SerialName("video_note")
    VIDEO_NOTE,
    @SerialName("audio")
    AUDIO,
    @SerialName("voice")
    VOICE,
    @SerialName("document")
    DOCUMENT,
}
