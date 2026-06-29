import {
  collectRecentSendMessageAssessments,
  RECENT_SEND_MESSAGE_WINDOW,
  renderRecentSendMessageHumanLikenessXml,
} from '../send-message-human-likeness';
import type { DriverFeature } from '../turn-features';
import type { MainTurnFeatureDeps } from './types';

export const createHumanLikenessFeature = (deps: MainTurnFeatureDeps): DriverFeature => ({
  name: 'human-likeness',
  preparePrompt: async ctx => {
    ctx.scratch.recentSendMessageHumanLikenessXml = renderRecentSendMessageHumanLikenessXml(
      collectRecentSendMessageAssessments(
        await deps.loadTurnResponses(deps.chatId),
        RECENT_SEND_MESSAGE_WINDOW,
        deps.chatConfig.humanLikeness,
      ),
    );
  },
});
