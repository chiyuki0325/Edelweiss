import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import type { Logger } from '@guiiai/logg';

import type { SkillInfo } from './skills';
import { createAskForImageTool, createBashTool, createAttachmentDownloader, createDownloadFileTool, createKillTaskTool, createReadImageTool, createReadTaskOutputTool, createSendMessageTool, createSleepTool, createWebFetchTool, createWebSearchTool, createStaySilentTool, createReactMessageTool, createEnterFocusTool } from './tools';
import type { CahciuaTool, SendMessageAttachment, SendMessageTurnFlags } from './tools';
import type { DriverSignal, TurnCapabilities, TurnState } from './turn-state';
import type { PlatformAdapter } from './types';
import { createWebFetcher } from './web-fetch';
import type { RuntimeConfig, ResolvedChatConfig } from '../config/config';
import type { LlmEndpoint } from '../llm/types';
import type { ImageConversationManager } from '../media/image-conversation';
import { renderImageToTextSystemPrompt } from '../media/image-to-text-prompt';
import type { InstantViewPhotoReference } from '../telegram/instant-view-url';
import type { Attachment } from '../telegram/message/types';

export interface CapabilityToolProviderDeps {
  chatId: string;
  chatConfig: ResolvedChatConfig;
  allSkills: Map<string, SkillInfo>;
  runtimeConfig: RuntimeConfig;
  loadMessageAttachments: (chatId: string, messageId: number) => Attachment[] | undefined;
  downloadFile: (fileId: string) => Promise<Buffer>;
  downloadMessageMedia?: (chatId: string, messageId: number) => Promise<Buffer | undefined>;
  fetchInstantView?: (url: string) => Promise<{ title?: string; content: string } | undefined>;
  downloadInstantViewPhoto?: (reference: InstantViewPhotoReference) => Promise<Buffer>;
  sendMessage: (chatId: string, text: string, replyToMessageId?: number, attachments?: SendMessageAttachment[]) => Promise<{ messageId: number; date: number }>;
  getPlatformAdapter?: (chatId: string) => PlatformAdapter | undefined;
  sendReaction?: (chatId: string, messageId: number, emoji: string) => Promise<void>;
  resolveModel: (name: string) => LlmEndpoint;
  imageConversations: ImageConversationManager;
  backgroundTask: {
    startTask: (typeName: string, sessionId: string, params: unknown, intention: string | undefined, timeoutMs: number) => number;
    killTask: (taskId: number) => { ok: boolean; error?: string };
    readTaskOutput: (taskId: number, offset?: number, limit?: number) => Promise<{ content: string; totalLines: number; truncated: boolean } | { error: string }>;
  };
  focusMode: DriverSignal<boolean>;
  getActiveTurn: () => TurnState | null;
  log: Logger;
}

export const createToolsForCapabilities = (
  deps: CapabilityToolProviderDeps,
  capabilities: TurnCapabilities,
  reactionEmojis: string[] = [],
  sendMessageTurnFlags?: SendMessageTurnFlags,
): CahciuaTool[] => {
  const {
    chatId,
    chatConfig,
    allSkills,
    runtimeConfig,
    log,
  } = deps;
  const platform = deps.getPlatformAdapter?.(chatId);
  const downloadAttachment = createAttachmentDownloader({
    chatId,
    loadMessageAttachments: deps.loadMessageAttachments,
    downloadFile: deps.downloadFile,
    downloadMessageMedia: deps.downloadMessageMedia,
    downloadInstantViewPhoto: deps.downloadInstantViewPhoto,
    platformAdapter: platform,
  });
  const canOfferReaction = capabilities.canReact
    && chatConfig.platform === 'telegram'
    && deps.sendReaction != null
    && reactionEmojis.length > 0;

  const createChatTools = (): CahciuaTool[] => {
    const tools: CahciuaTool[] = [];
    if (capabilities.canSendMessage) {
      tools.push(createSendMessageTool(async (text, replyTo, attachments) => {
        log.withFields({
          chatId,
          text: text.length > 100 ? `${text.slice(0, 100)}...` : text,
          replyTo,
          attachments: attachments?.length ?? 0,
        }).log('send_message tool called');
        if (platform) {
          const result = await platform.sendMessage(chatId, text, { replyTo, attachments });
          return { messageId: result.messageId };
        }
        if (chatConfig.platform === 'onebot')
          throw new Error(`OneBot adapter unavailable for chat ${chatId}; refusing Telegram fallback`);
        const sent = await deps.sendMessage(chatId, text, replyTo ? Number(replyTo) : undefined, attachments);
        return { messageId: String(sent.messageId) };
      }, sendMessageTurnFlags, canOfferReaction));
    }
    tools.push(createEnterFocusTool({ focusMode: deps.focusMode, getActiveTurn: deps.getActiveTurn }));
    if (capabilities.canDismissMessage)
      tools.push(createStaySilentTool());
    return tools;
  };

  const createReactionTools = (): CahciuaTool[] => {
    if (!canOfferReaction)
      return [];
    return [createReactMessageTool(reactionEmojis, async (messageId, emoji) => {
      const numericMessageId = Number(messageId);
      if (!Number.isInteger(numericMessageId) || numericMessageId <= 0)
        throw new Error(`Invalid Telegram message id for react_message: ${messageId}`);
      await deps.sendReaction!(chatId, numericMessageId, emoji);
    })];
  };

  const createBashTools = (): CahciuaTool[] => {
    if (!capabilities.canUseBash) return [];
    return [createBashTool(runtimeConfig, {
      startTask: deps.backgroundTask.startTask,
      sessionId: chatId,
      backgroundThresholdSec: chatConfig.tools.bash.backgroundThresholdSec,
      compactOutput: chatConfig.tools.bash.compactOutput,
      pseudoCommands: {
        chatId,
        currentChannel: chatConfig.platform,
        ...(chatConfig.skills?.folder ? { skillsFolder: resolve(chatConfig.skills.folder) } : {}),
        skills: allSkills,
      },
    })];
  };

  const createWebTools = (): CahciuaTool[] => [
    ...(capabilities.canUseWebSearch ? [createWebSearchTool(chatConfig.tools.webSearch.tavilyKey)] : []),
    ...(capabilities.canUseWebFetch && chatConfig.tools.webFetch
      ? [createWebFetchTool(createWebFetcher(chatConfig.tools.webFetch, {
          ...(deps.fetchInstantView ? { instantView: { fetch: deps.fetchInstantView } } : {}),
          onInstantViewError: (error, url) => {
            log.withError(error).withFields({ url }).warn('Instant View fetch failed; falling back to Jina');
          },
        }))]
      : []),
  ];

  const createDownloadTools = (): CahciuaTool[] =>
    capabilities.canDownloadFile
      ? [createDownloadFileTool({ downloadAttachment, runtime: runtimeConfig })]
      : [];

  const createReadImageTools = (): CahciuaTool[] => {
    if (!capabilities.canReadImage) return [];
    const readFileCmd = runtimeConfig.readFile;
    const resolveImageToText = chatConfig.imageToText.model
      ? async (buffer: Buffer, detail: 'low' | 'high', sourceKey: string) => {
        const system = await renderImageToTextSystemPrompt({ caption: '', detail });
        const model = deps.resolveModel(chatConfig.imageToText.model!);
        const result = await deps.imageConversations.start({
          chatId,
          sourceKey: `read_image:${sourceKey}:${detail}`,
          imageHash: createHash('sha256').update(buffer).digest('hex'),
          preparedImage: buffer,
          systemPrompt: system,
          initialUserText: 'Describe this image.',
          model,
          label: 'read-image',
        });
        return { description: result.description, imageId: result.imageId, reused: result.reused };
      }
      : undefined;

    return [createReadImageTool({
      downloadAttachment,
      readFile: async path => {
        const { execFile } = await import('node:child_process');
        return await new Promise<Buffer>((resolve, reject) => {
          const child = execFile(
            readFileCmd[0]!,
            [...readFileCmd.slice(1), path],
            { timeout: 60_000, maxBuffer: runtimeConfig.readFileSizeLimit, encoding: 'buffer' as any },
            (error, stdout) => {
              if (error) reject(new Error(`Failed to read file: ${error.message}`));
              else resolve(stdout as unknown as Buffer);
            },
          );
          child.stdin?.end();
        });
      },
      resolveImageToText,
    })];
  };

  const createAskForImageTools = (): CahciuaTool[] => {
    if (!capabilities.canAskForImage || !chatConfig.imageToText.model) return [];
    const model = deps.resolveModel(chatConfig.imageToText.model);
    return [createAskForImageTool({
      ask: async (imageId, question) => await deps.imageConversations.ask({
        chatId,
        imageId,
        question,
        model,
        maxContextEstTokens: chatConfig.imageToText.maxContextEstTokens,
      }),
    })];
  };

  const createBackgroundTaskTools = (): CahciuaTool[] =>
    capabilities.canUseBackgroundTasks
      ? [
          createKillTaskTool(taskId => deps.backgroundTask.killTask(taskId)),
          createReadTaskOutputTool((taskId, offset, limit) => deps.backgroundTask.readTaskOutput(taskId, offset, limit)),
          createSleepTool(),
        ]
      : [];

  return [
    ...createChatTools(),
    ...createReactionTools(),
    ...createBashTools(),
    ...createWebTools(),
    ...createDownloadTools(),
    ...createReadImageTools(),
    ...createAskForImageTools(),
    ...createBackgroundTaskTools(),
  ];
};
