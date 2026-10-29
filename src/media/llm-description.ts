import type { Logger } from '@guiiai/logg';
import sharp from 'sharp';

import { callLlm, type LlmCallConfig } from '../driver/call-llm';
import { humanMessage, imageBlock, messageText, textBlock, type DriverMessage } from '../driver/messages';
import type { LlmEndpoint } from '../llm/types';

export const createSemaphore = (max: number) => {
  let current = 0;
  const queue: (() => void)[] = [];
  return {
    acquire: () => new Promise<void>(resolve => {
      if (current < max) { current++; resolve(); } else queue.push(resolve);
    }),
    release: () => {
      current--;
      const next = queue.shift();
      if (next) { current++; next(); }
    },
  };
};

const extractDescriptionText = (entries: DriverMessage[]): string =>
  entries.map(messageText).join('').trim();

/** Shared LLM call for image/animation description workflows. */
export const callDescriptionLlm = async (params: {
  model: LlmEndpoint;
  system: string;
  userText: string;
  images: Buffer[];
  log: Logger;
  label: string;
}): Promise<{ text: string; outputTokens: number }> => {
  const { model, system, userText, images, log, label } = params;

  log.withFields({ systemLen: system.length, images: images.length, apiFormat: model.apiFormat ?? 'openai-chat' }).log(`${label} request`);

  const entries: DriverMessage[] = [
    humanMessage([
      textBlock(userText),
      ...images.map(buffer => imageBlock(sharp(buffer), undefined)),
    ]),
  ];

  const config: LlmCallConfig = {
    apiBaseUrl: model.apiBaseUrl,
    apiKey: model.apiKey,
    model: model.model,
    ...(model.apiFormat ? { apiFormat: model.apiFormat } : {}),
    ...(model.timeoutSec ? { timeoutSec: model.timeoutSec } : {}),
    ...(model.extraBody ? { extraBody: model.extraBody } : {}),
    ...(model.toolChoice ? { toolChoice: model.toolChoice } : {}),
    localForceMaxRetries: model.localForceMaxRetries,
  };

  const result = await callLlm(
    config,
    entries,
    system,
    undefined,
    { log, label, ...(model.maxImagesAllowed ? { maxImagesAllowed: model.maxImagesAllowed } : {}) },
  );

  return {
    text: extractDescriptionText(result.entries),
    outputTokens: result.usage.outputTokens,
  };
};
