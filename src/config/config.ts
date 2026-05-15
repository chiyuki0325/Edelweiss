import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { merge } from 'es-toolkit';
import * as v from 'valibot';
import { parse as parseYaml } from 'yaml';

import type { CompactionConfig, LlmEndpoint, ProviderFormat } from '../driver/types';

const llmEndpointEntries = {
  apiBaseUrl: v.string(),
  apiKey: v.string(),
  model: v.string(),
  apiFormat: v.optional(v.picklist(['openai-chat', 'responses', 'anthropic-messages'])),
  maxImagesAllowed: v.optional(v.number()),
  timeoutSec: v.optional(v.number()),
  descriptionConcurrency: v.optional(v.number()),
  reasoningEffort: v.optional(v.picklist(['low', 'medium', 'high', 'max', 'xhigh'])),
};

// --- Runtime config schema (top-level, global) ---

const DEFAULT_FILE_SIZE_LIMIT = 20 * 1024 * 1024; // 20 MB

const RuntimeSchema = v.object({
  shell: v.optional(v.array(v.string()), ['/bin/bash', '-c']),
  writeFile: v.array(v.string()),
  readFile: v.array(v.string()),
  writeFileSizeLimit: v.optional(v.number(), DEFAULT_FILE_SIZE_LIMIT),
  readFileSizeLimit: v.optional(v.number(), DEFAULT_FILE_SIZE_LIMIT),
});

// --- Chat-level config schemas ---

const ChatConfigSchema = v.object({
  platform: v.optional(v.picklist(['telegram', 'onebot']), 'telegram'),
  model: v.optional(v.string(), 'primary'),
  systemFiles: v.optional(v.array(v.string()), []),
  compaction: v.optional(v.object({
    maxContextEstTokens: v.optional(v.number(), 200000),
    workingWindowEstTokens: v.optional(v.number(), 8000),
    model: v.optional(v.string()),
  }), {}),
  probe: v.optional(v.object({
    enabled: v.optional(v.boolean(), false),
    model: v.optional(v.string(), ''),
  }), {}),
  subagents: v.optional(v.object({
    enabled: v.optional(v.boolean(), true),
    model: v.optional(v.string(), ''),
    maxConcurrent: v.optional(v.number(), 2),
    maxSteps: v.optional(v.number(), 8),
  }), {}),
  imageToText: v.optional(v.object({
    enabled: v.optional(v.boolean(), false),
    model: v.optional(v.string(), ''),
    compress: v.optional(v.boolean(), true),
    pixelBudget: v.optional(v.number(), 512 * 512),
  }), {}),
  animationToText: v.optional(v.object({
    enabled: v.optional(v.boolean(), false),
    model: v.optional(v.string(), ''),
    maxFrames: v.optional(v.number(), 5),
  }), {}),
  customEmojiToText: v.optional(v.object({
    enabled: v.optional(v.boolean(), false),
    model: v.optional(v.string(), ''),
    maxFrames: v.optional(v.number(), 5),
  }), {}),
  debounce: v.optional(v.object({
    initialDelayMs: v.optional(v.number(), 5000),
    typingExtendMs: v.optional(v.number(), 5000),
    maxDelayMs: v.optional(v.number(), 30000),
  }), {}),
  humanLikeness: v.optional(v.object({
    trailingPeriod: v.optional(v.boolean(), true),
    denseClausePunctuation: v.optional(v.boolean(), true),
    multipleMarkdownBold: v.optional(v.boolean(), true),
    markdownList: v.optional(v.boolean(), true),
    markdownHeader: v.optional(v.boolean(), true),
    newline: v.optional(v.boolean(), true),
    queshi: v.optional(v.boolean(), true),
  }), {}),
  skills: v.optional(v.object({
    folder: v.pipe(v.string(), v.nonEmpty()),
  })),
  tools: v.object({
    bash: v.optional(v.object({
      backgroundThresholdSec: v.optional(v.number(), 10),
    }), {}),
    webSearch: v.object({
      tavilyKey: v.pipe(v.string(), v.minLength(1)),
    }),
  }),
});

// Per-chat overrides: all fields optional, no defaults
const ChatOverrideSchema = v.optional(v.partial(v.object({
  platform: v.picklist(['telegram', 'onebot']),
  model: v.string(),
  systemFiles: v.array(v.string()),
  compaction: v.partial(v.object({
    maxContextEstTokens: v.number(),
    workingWindowEstTokens: v.number(),
    model: v.string(),
  })),
  probe: v.partial(v.object({
    enabled: v.boolean(),
    model: v.string(),
  })),
  subagents: v.partial(v.object({
    enabled: v.boolean(),
    model: v.string(),
    maxConcurrent: v.number(),
    maxSteps: v.number(),
  })),
  imageToText: v.partial(v.object({
    enabled: v.boolean(),
    model: v.string(),
    compress: v.boolean(),
    pixelBudget: v.number(),
  })),
  animationToText: v.partial(v.object({
    enabled: v.boolean(),
    model: v.string(),
    maxFrames: v.number(),
  })),
  customEmojiToText: v.partial(v.object({
    enabled: v.boolean(),
    model: v.string(),
    maxFrames: v.number(),
  })),
  debounce: v.partial(v.object({
    initialDelayMs: v.number(),
    typingExtendMs: v.number(),
    maxDelayMs: v.number(),
  })),
  humanLikeness: v.partial(v.object({
    trailingPeriod: v.boolean(),
    denseClausePunctuation: v.boolean(),
    multipleMarkdownBold: v.boolean(),
    markdownList: v.boolean(),
    markdownHeader: v.boolean(),
    newline: v.boolean(),
    queshi: v.boolean(),
  })),
  skills: v.object({
    folder: v.string(),
  }),
  tools: v.partial(v.object({
    bash: v.partial(v.object({
      backgroundThresholdSec: v.number(),
    })),
    webSearch: v.partial(v.object({
      tavilyKey: v.string(),
    })),
  })),
})), {});

const BackgroundTasksSchema = v.optional(v.object({
  outputDir: v.optional(v.string(), './data/task-outputs'),
  retentionCount: v.optional(v.number(), 20),
}), {});

const OneBotConfigSchema = v.optional(v.object({
  enabled: v.optional(v.boolean(), false),
  host: v.optional(v.string(), '0.0.0.0'),
  port: v.optional(v.number(), 3001),
  accessToken: v.optional(v.string(), ''),
}), {});

const ConfigSchema = v.object({
  models: v.record(v.string(), v.object(llmEndpointEntries)),
  telegram: v.optional(v.object({
    botToken: v.string(),
    apiId: v.optional(v.number()),
    apiHash: v.optional(v.string()),
    session: v.optional(v.string(), ''),
  })),
  onebot: OneBotConfigSchema,
  database: v.optional(v.object({
    path: v.optional(v.string(), './data/cahciua.db'),
  }), {}),
  runtime: RuntimeSchema,
  backgroundTasks: BackgroundTasksSchema,
  chats: v.objectWithRest({ default: ChatConfigSchema }, ChatOverrideSchema),
});

export type Config = v.InferOutput<typeof ConfigSchema>;
export type ChatConfig = v.InferOutput<typeof ChatConfigSchema>;

export interface RuntimeConfig {
  shell: string[];
  writeFile: string[];
  readFile: string[];
  writeFileSizeLimit: number;
  readFileSizeLimit: number;
}

export interface BackgroundTasksConfig {
  outputDir: string;
  retentionCount: number;
}

export interface ResolvedChatConfig {
  platform: 'telegram' | 'onebot';
  primaryModel: LlmEndpoint;
  primaryApiFormat: ProviderFormat;
  systemFiles: { filename: string; content: string }[];
  compaction: CompactionConfig;
  probe: { enabled: boolean; model: LlmEndpoint };
  subagents: {
    enabled: boolean;
    model: LlmEndpoint;
    apiFormat: ProviderFormat;
    maxConcurrent: number;
    maxSteps: number;
  };
  imageToText: { enabled: boolean; model?: string; compress: boolean; pixelBudget: number };
  animationToText: { enabled: boolean; model?: string; maxFrames: number };
  customEmojiToText: { enabled: boolean; model?: string; maxFrames: number };
  debounce: {
    initialDelayMs: number;
    typingExtendMs: number;
    maxDelayMs: number;
  };
  humanLikeness: {
    trailingPeriod: boolean;
    denseClausePunctuation: boolean;
    multipleMarkdownBold: boolean;
    markdownList: boolean;
    markdownHeader: boolean;
    newline: boolean;
    queshi: boolean;
  };
  skills?: { folder: string };
  tools: {
    bash: { backgroundThresholdSec: number };
    webSearch: { tavilyKey: string };
  };
}

const CONFIG_PATH = process.env.CONFIG_PATH ?? 'config.yaml';

export const loadConfig = (): Config => {
  const raw = readFileSync(CONFIG_PATH, 'utf-8');
  const parsed = parseYaml(raw);
  return v.parse(ConfigSchema, parsed);
};

export const resolveRuntime = (config: Config): RuntimeConfig => ({
  shell: config.runtime.shell,
  writeFile: config.runtime.writeFile,
  readFile: config.runtime.readFile,
  writeFileSizeLimit: config.runtime.writeFileSizeLimit,
  readFileSizeLimit: config.runtime.readFileSizeLimit,
});

export const resolveBackgroundTasks = (config: Config): BackgroundTasksConfig => ({
  outputDir: config.backgroundTasks.outputDir,
  retentionCount: config.backgroundTasks.retentionCount,
});

export const resolveModel = (config: Config, name: string): LlmEndpoint => {
  const entry = config.models[name];
  if (!entry) throw new Error(`Unknown model "${name}" — not found in models registry`);
  return entry;
};

/** Return whitelisted chat IDs (all keys in chats except "default"). */
export const getChatIds = (config: Config): string[] =>
  Object.keys(config.chats).filter(k => k !== 'default');

/** Deep-merge default chat config with per-chat overrides and resolve model names. */
export const resolveChatConfig = (config: Config, chatId: string): ResolvedChatConfig => {
  const override = config.chats[chatId] ?? {};
  const merged: ChatConfig = merge(structuredClone(config.chats.default), override);

  const primaryModel = resolveModel(config, merged.model);
  const primaryApiFormat: ProviderFormat = primaryModel.apiFormat ?? 'openai-chat';
  const subagentModel = merged.subagents.model ? resolveModel(config, merged.subagents.model) : primaryModel;

  const systemFiles = merged.systemFiles.map(filePath => ({
    filename: basename(filePath),
    content: readFileSync(filePath, 'utf-8').trim(),
  }));

  return {
    platform: merged.platform,
    primaryModel,
    primaryApiFormat,
    systemFiles,
    compaction: {
      ...merged.compaction,
      model: merged.compaction.model ? resolveModel(config, merged.compaction.model) : undefined,
    },
    probe: {
      enabled: merged.probe.enabled,
      model: merged.probe.model ? resolveModel(config, merged.probe.model) : primaryModel,
    },
    subagents: {
      enabled: merged.subagents.enabled,
      model: subagentModel,
      apiFormat: subagentModel.apiFormat ?? 'openai-chat',
      maxConcurrent: merged.subagents.maxConcurrent,
      maxSteps: merged.subagents.maxSteps === 0 ? Infinity : merged.subagents.maxSteps,
    },
    imageToText: {
      enabled: merged.imageToText.enabled,
      model: merged.imageToText.model || undefined,
      compress: merged.imageToText.compress,
      pixelBudget: merged.imageToText.pixelBudget,
    },
    animationToText: {
      enabled: merged.animationToText.enabled,
      model: merged.animationToText.model || undefined,
      maxFrames: merged.animationToText.maxFrames,
    },
    customEmojiToText: {
      enabled: merged.customEmojiToText.enabled,
      model: merged.customEmojiToText.model || undefined,
      maxFrames: merged.customEmojiToText.maxFrames,
    },
    skills: merged.skills,
    debounce: merged.debounce,
    humanLikeness: merged.humanLikeness,
    tools: {
      bash: { backgroundThresholdSec: merged.tools.bash.backgroundThresholdSec },
      webSearch: { tavilyKey: merged.tools.webSearch.tavilyKey },
    },
  };
};
