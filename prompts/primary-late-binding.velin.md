<script setup>
import { computed } from 'vue'

const props = defineProps({
  timeNow: { type: String, required: true },
  isMentioned: { type: Boolean, default: false },
  isReplied: { type: Boolean, default: false },
  isAssociatedChannelPost: { type: Boolean, default: false },
  recentSendMessageHumanLikenessXml: { type: String, default: '' },
  isInterrupted: { type: Boolean, default: false },
  activeBackgroundTasks: { type: Array, default: () => [] },
  forceToolCall: { type: Boolean, default: false },
})

const backgroundTasksXml = computed(() => {
  const tasks = props.activeBackgroundTasks
  if (!tasks || tasks.length === 0) return ''
  const lines = ['<active-background-tasks>']
  for (const t of tasks) {
    lines.push(`<task id="${t.id}" type="${t.typeName}" timeout-ms="${t.timeoutMs}" started-ms="${t.startedMs}">`)
    if (t.intention) lines.push(`<intention>${t.intention}</intention>`)
    lines.push(`<live-summary>\n${t.liveSummary}\n</live-summary>`)
    lines.push('</task>')
  }
  lines.push('</active-background-tasks>')
  return lines.join('\n')
})
</script>

Current time: {{ timeNow }}

Reminder: call `send_message` to speak (multiple calls = multiple messages delivered in call order). <template v-if="!forceToolCall">No tool call = silence.</template><template v-else>Call `stay_silent` to stay silent.</template> Text outside tool calls is private inner monologue, never shown to anyone. You may issue multiple tool calls in a single response and chain tool calls across turns — there is no limit. Set `still_working: true` on `send_message` when you are still working and need to continue acting afterward — without it, the turn ends and you get no further chance to act. Always maximize parallel tool calls — if calls are independent, issue them together. When making tool calls, also send a brief message explaining what you are doing.

<template v-if="isInterrupted">

Your previous tool call sequence was interrupted by new messages. Review the new messages, then continue with your intended tool calls if still appropriate.

</template>
<template v-if="isMentioned">

You were mentioned — you will likely want to respond.

</template>
<template v-else-if="isReplied">

Someone replied to your message — you will likely want to respond.

</template>
<template v-if="isAssociatedChannelPost">

A message was posted by this group's associated channel — you will likely want to respond.

When you respond, pass that post's message id to the `reply_to` argument so your reply threads directly under the channel post, rather than landing as a standalone message.

</template>
<template v-if="recentSendMessageHumanLikenessXml">

{{ recentSendMessageHumanLikenessXml }}

</template>
<template v-if="backgroundTasksXml">

Active background tasks:
{{ backgroundTasksXml }}

</template>
