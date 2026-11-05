package ink.chyk.edelweiss.config

import com.sksamuel.hoplite.ArrayNode
import com.sksamuel.hoplite.MapNode
import com.sksamuel.hoplite.Node
import com.sksamuel.hoplite.StringNode
import com.sksamuel.hoplite.transformer.NodeTransformer
import com.sksamuel.hoplite.transformer.PathNormalizer

/**
 * 将profiles/entries/use结构展开为普通的具名配置映射。
 *
 * use中的profile按数组顺序合并，靠后的profile覆盖靠前的profile，
 * entry自身的字段最后覆盖所有profile。对象字段递归合并，其他值整体替换。
 */
object ProfileNodeTransformer : NodeTransformer {
    private const val PROFILES_KEY = "profiles"
    private const val ENTRIES_KEY = "entries"
    private const val USE_KEY = "use"

    override fun transformPathElement(element: String): String = element

    override fun transform(node: Node, sealedTypeDiscriminatorField: String?): Node {
        if (node !is MapNode) {
            return node
        }

        val profiles = node.map[PROFILES_KEY] as? MapNode ?: return node
        val entries = node.map[ENTRIES_KEY] as? MapNode ?: return node
        val resolvedEntries = entries.map.map { (normalizedEntryName, entryNode) ->
            val entryName = originalChildKey(entries, normalizedEntryName, entryNode)
            entryName to resolveEntry(node, profiles, entryName, entryNode)
        }.toMap()

        return node.copy(map = resolvedEntries)
    }

    private fun originalChildKey(
        parent: MapNode,
        normalizedKey: String,
        child: Node,
    ): String {
        val childSourceKey = child.sourceKey ?: return normalizedKey
        val parentSourceKey = parent.sourceKey
        if (parentSourceKey != null) {
            val prefix = "$parentSourceKey${parent.delimiter}"
            if (childSourceKey.startsWith(prefix)) {
                return childSourceKey.removePrefix(prefix)
            }
        }

        return childSourceKey.takeUnless { parent.delimiter in it } ?: normalizedKey
    }

    private fun resolveEntry(
        section: MapNode,
        profiles: MapNode,
        entryName: String,
        entryNode: Node,
    ): Node {
        require(entryNode is MapNode) {
            "Profile entry '$entryName' in '${section.sourceKey ?: "<root>"}' must be an object"
        }

        val selectedProfiles = readProfileNames(section, entryName, entryNode.map[USE_KEY])
        val inherited = selectedProfiles.fold(emptyMap<String, Node>()) { merged, profileName ->
            val profile = findProfile(profiles, profileName)
            require(profile is MapNode) {
                "Unknown profile '$profileName' used by entry '$entryName' " +
                    "in '${section.sourceKey ?: "<root>"}'"
            }
            deepMerge(merged, profile.map)
        }
        val ownValues = entryNode.map - USE_KEY

        return entryNode.copy(map = deepMerge(inherited, ownValues))
    }

    private fun findProfile(profiles: MapNode, profileName: String): Node? =
        profiles.map.entries
            .firstOrNull { (normalizedName, profile) ->
                originalChildKey(profiles, normalizedName, profile) == profileName
            }
            ?.value
            ?: profiles.map[profileName]
            ?: profiles.map[PathNormalizer.transformPathElement(profileName)]

    private fun readProfileNames(
        section: MapNode,
        entryName: String,
        useNode: Node?,
    ): List<String> {
        if (useNode == null) {
            return emptyList()
        }

        require(useNode is ArrayNode) {
            "'use' of entry '$entryName' in '${section.sourceKey ?: "<root>"}' must be an array"
        }

        return useNode.elements.map { element ->
            require(element is StringNode) {
                "'use' of entry '$entryName' in '${section.sourceKey ?: "<root>"}' " +
                    "may only contain profile names"
            }
            element.value
        }
    }

    private fun deepMerge(
        base: Map<String, Node>,
        override: Map<String, Node>,
    ): Map<String, Node> {
        val merged = base.toMutableMap()
        override.forEach { (key, overrideValue) ->
            val baseValue = merged[key]
            merged[key] =
                if (baseValue is MapNode && overrideValue is MapNode) {
                    overrideValue.copy(map = deepMerge(baseValue.map, overrideValue.map))
                } else {
                    overrideValue
                }
        }
        return merged
    }
}
