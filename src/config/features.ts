import * as v from 'valibot';

const boolFlag = v.pipe(
  v.optional(v.string(), ''),
  v.transform(s => s === '1' || s === 'true'),
);

const FeaturesSchema = v.object({
  // Trim TRs that contain no tool calls (pure text responses), keeping only the
  // latest N. Older no-tool-call TRs contribute little to context quality but
  // consume tokens. TRs with tool calls are always kept (tool results are
  // structurally important for role alternation and model grounding).
  FEATURE_TRIM_STALE_NO_TOOL_CALL_TRS: boolFlag,

  // When the bot sends a message via the send_message tool, the message enters
  // RC via userbot reception AND stays in the TR as a tool call result. This
  // flag filters RC segments marked isSelfSent=true from context assembly,
  // removing the duplicate representation.
  FEATURE_TRIM_SELF_MESSAGES_COVERED_BY_SEND_TOOL_CALLS: boolFlag,
});

export interface FeatureFlags {
  trimStaleNoToolCallTurnResponses: boolean;
  trimSelfMessagesCoveredBySendToolCalls: boolean;
}

export const loadFeatureFlags = (): FeatureFlags => {
  const parsed = v.parse(FeaturesSchema, process.env);
  return {
    trimStaleNoToolCallTurnResponses: parsed.FEATURE_TRIM_STALE_NO_TOOL_CALL_TRS,
    trimSelfMessagesCoveredBySendToolCalls: parsed.FEATURE_TRIM_SELF_MESSAGES_COVERED_BY_SEND_TOOL_CALLS,
  };
};
