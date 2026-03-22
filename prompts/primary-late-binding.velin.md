<script setup>
defineProps({
  timeNow: { type: String, required: true },
  isProbeEnabled: { type: Boolean, default: false },
  isProbing: { type: Boolean, default: false },
  isMentioned: { type: Boolean, default: false },
  isReplied: { type: Boolean, default: false },
})
</script>

Current time: {{ timeNow }}

Reminder: call `send_message` to speak (multiple calls = multiple messages). No tool call = silence. Text outside tool calls is private inner monologue, never shown to anyone. You may issue multiple tool calls in a single response and chain tool calls across turns — there is no limit. Set `await_response: true` on `send_message` when you need to continue acting afterward. Always maximize parallel tool calls — if calls are independent, fire them all at once. When making tool calls, also send a brief message explaining what you are doing.

<div v-if="isProbeEnabled && !isProbing">

You have already decided to act after deliberation. Make your tool calls now.

</div>
<div v-else-if="isMentioned">

You were mentioned — you will likely want to respond.

</div>
<div v-else-if="isReplied">

Someone replied to your message — you will likely want to respond.

</div>
