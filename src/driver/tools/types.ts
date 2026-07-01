import { Validator } from '@cfworker/json-schema';

import type { InputPart } from '../../unified-api/types';

export interface ToolResult {
  content: string | InputPart[];
  requiresFollowUp: boolean;
}

export const isToolResult = (v: unknown): v is ToolResult =>
  typeof v === 'object' && v !== null && 'requiresFollowUp' in v;

export interface CahciuaToolExecuteOptions {
  toolCallId: string;
}

export interface CahciuaTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
  validate: (input: unknown) => { valid: boolean; errors: string[] };
  execute: (input: unknown, options: CahciuaToolExecuteOptions) => Promise<ToolResult> | ToolResult;
}

export const createTool = (def: {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
  execute: CahciuaTool['execute'];
}): CahciuaTool => {
  const validator = new Validator(def.parameters as object);
  return {
    type: 'function',
    function: {
      name: def.name,
      parameters: def.parameters,
      ...(def.description ? { description: def.description } : {}),
      ...(def.strict != null ? { strict: def.strict } : {}),
    },
    validate: (input: unknown) => {
      const result = validator.validate(input);
      return {
        valid: result.valid,
        errors: result.errors.map(e => `${e.instanceLocation}: ${e.error}`),
      };
    },
    execute: def.execute,
  };
};

export interface SendMessageAttachment {
  type: 'document' | 'photo' | 'video' | 'audio' | 'voice' | 'animation' | 'video_note';
  path: string;
  file_name?: string;
}

export interface SendMessageTurnFlags {
  wasLengthLimited: boolean;
  inFocusMode: boolean;
}
