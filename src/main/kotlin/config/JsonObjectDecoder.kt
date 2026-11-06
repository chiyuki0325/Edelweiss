package ink.chyk.edelweiss.config

import com.sksamuel.hoplite.*
import com.sksamuel.hoplite.decoder.Decoder
import com.sksamuel.hoplite.fp.invalid
import com.sksamuel.hoplite.fp.valid
import kotlinx.serialization.json.*
import kotlin.reflect.KType

// Model.extraBody 字段需要向上传递原始 JsonObject，而不是被 Hoplite 转换为 Map<String, Any>，因此需要自定义 Decoder
object JsonObjectDecoder : Decoder<JsonObject> {
    override fun supports(type: KType): Boolean =
        type.classifier == JsonObject::class

    override fun decode(
        node: Node,
        type: KType,
        context: DecoderContext,
    ): ConfigResult<JsonObject> =
        if (node is MapNode) {
            node.markUsed(context)
            node.toJsonObject().valid()
        } else {
            ConfigFailure.DecodeError(node, type).invalid()
        }

    private fun Node.markUsed(context: DecoderContext) {
        context.usedPaths.add(path)
        when (this) {
            is MapNode -> map.values.forEach { it.markUsed(context) }
            is ArrayNode -> elements.forEach { it.markUsed(context) }
            else -> Unit
        }
    }

    private fun MapNode.toJsonObject(): JsonObject =
        JsonObject(map.mapValues { (_, value) -> value.toJsonElement() })

    private fun Node.toJsonElement(): JsonElement =
        when (this) {
            is MapNode -> toJsonObject()
            is ArrayNode -> JsonArray(elements.map { it.toJsonElement() })
            is StringNode -> JsonPrimitive(value)
            is BooleanNode -> JsonPrimitive(value)
            is LongNode -> JsonPrimitive(value)
            is DoubleNode -> JsonPrimitive(value)
            is NullNode -> JsonNull
            else -> error("Unsupported config node $simpleName at ${sourceKey ?: "<unknown>"}")
        }
}
