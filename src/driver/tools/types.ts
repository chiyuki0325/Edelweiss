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

export type ToolExecutionLane = 'prelude' | 'readonly' | 'writer' | 'message' | 'serial';

export interface ToolExecutionPolicy {
  /** Execution lane within one model step. Unspecified tools default to the safe serial lane. */
  lane: ToolExecutionLane;
  /** Delay this call until every writer in the same model step has settled. */
  waitForWriters?: (input: unknown) => boolean;
}

export interface CahciuaTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
  execution?: ToolExecutionPolicy;
  validate: (input: unknown) => { valid: boolean; errors: string[] };
  execute: (input: unknown, options: CahciuaToolExecuteOptions) => Promise<ToolResult> | ToolResult;
}

export const createTool = (def: {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
  execution?: ToolExecutionPolicy;
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
    ...(def.execution ? { execution: def.execution } : {}),
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
