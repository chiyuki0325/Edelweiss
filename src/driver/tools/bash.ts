import { execFile, spawn, spawnSync } from 'node:child_process';

import { useGlobalLogger } from '@guiiai/logg';

import type { SkillInfo } from '../skills';
import type { CahciuaTool, ToolResult } from './types';
import { createTool } from './types';
import type { RuntimeConfig } from '../../config/config';

// ── Pseudo commands ──

export interface PseudoCommandContext {
  chatId: string;
  currentChannel: string;
  skillsFolder?: string;
  skills: Map<string, SkillInfo>;
}

export interface PseudoCommandResult {
  exitCode: number;
  output: string;
}

const shellWords = (command: string): string[] => {
  const words: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (const match of command.matchAll(re)) {
    const doubleQuoted = match[1];
    const singleQuoted = match[2];
    const bare = match[3];
    if (doubleQuoted != null) {
      words.push(doubleQuoted.replace(/\\(["\\$`])/g, '$1'));
    } else if (singleQuoted != null) {
      words.push(singleQuoted);
    } else if (bare != null) {
      words.push(bare);
    }
  }
  return words;
};

const jsonOutput = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const catalogSkill = (skill: SkillInfo): Record<string, unknown> => ({
  id: skill.name,
  format: skill.format,
  ...(skill.format === 'custom-v2' && skill.title ? { title: skill.title } : {}),
  ...(skill.description ? { description: skill.description } : {}),
  ...(skill.usage ? { usage: skill.usage } : {}),
});

const fullSkillInfo = (skill: SkillInfo): Record<string, unknown> => ({
  ...catalogSkill(skill),
  ...(skill.skillsFolder ? { skillsFolder: skill.skillsFolder } : {}),
  ...(skill.skillPath ? { skillPath: skill.skillPath } : {}),
  ...(skill.mainFilePath ? { mainFilePath: skill.mainFilePath } : {}),
  resourceFiles: skill.resourceFiles ?? [],
});

export const executePseudoCommand = (
  command: string,
  context: PseudoCommandContext,
): PseudoCommandResult | null => {
  const argv = shellWords(command);
  const commandName = argv[0];
  if (commandName !== 'chat_info' && commandName !== 'skill_info') return null;

  if (commandName === 'chat_info') {
    if (argv.length > 1) {
      return {
        exitCode: 2,
        output: jsonOutput({ error: 'Usage: chat_info' }),
      };
    }
    return {
      exitCode: 0,
      output: jsonOutput({
        chatId: context.chatId,
        currentChannel: context.currentChannel,
        skillsFolder: context.skillsFolder ?? null,
      }),
    };
  }

  const skillId = argv[1];
  if (!skillId || argv.length > 2) {
    return {
      exitCode: 2,
      output: jsonOutput({ error: 'Usage: skill_info <skill_id>' }),
    };
  }

  const skill = context.skills.get(skillId);
  if (!skill) {
    return {
      exitCode: 1,
      output: jsonOutput({ error: `Skill "${skillId}" not found.` }),
    };
  }

  return {
    exitCode: 0,
    output: jsonOutput(fullSkillInfo(skill)),
  };
};

// ── Bash tool ──

const BASH_MAX_OUTPUT = 4096;
const BASH_TIMEOUT_MS = 30_000;

const RTK_NATIVE_COMMANDS = new Set([
  'ls', 'tree', 'read', 'find', 'grep', 'wc', 'wget', 'diff',
  'git', 'gh', 'glab',
  'cargo', 'dotnet', 'npm', 'npx', 'pnpm',
  'jest', 'vitest', 'pytest', 'tsc', 'next', 'lint', 'prettier', 'format', 'ruff', 'mypy', 'playwright',
  'rubocop', 'rspec', 'rake', 'golangci-lint', 'gradlew',
  'aws', 'docker', 'kubectl', 'prisma', 'psql',
  'smart', 'summary', 'err', 'test', 'json', 'deps', 'env', 'log',
  'curl', 'go', 'gt', 'pip',
]);

const extractArgv0 = (command: string): string | null =>
  command.trimStart().match(/^[^\s]+/)?.[0] ?? null;

export const createBashTool = (runtime: RuntimeConfig, backgroundTask: {
  startTask: (typeName: string, sessionId: string, params: unknown, intention: string | undefined, timeoutMs: number) => number;
  sessionId: string;
  backgroundThresholdSec: number;
  compactOutput: boolean;
  pseudoCommands?: PseudoCommandContext;
}): CahciuaTool => {
  let rtkAvailable: boolean | null = null;
  const checkRtk = (): boolean => {
    if (rtkAvailable !== null) return rtkAvailable;
    const result = spawnSync('which', ['rtk'], { stdio: 'pipe' });
    rtkAvailable = result.status === 0;
    if (!rtkAvailable && backgroundTask.compactOutput) {
      useGlobalLogger('bash').warn('rtk not found in PATH, compactOutput will have no effect');
    }
    return rtkAvailable;
  };

  return createTool({
    name: 'bash',
    description:
    'Execute a shell command. Output (stdout+stderr combined) is truncated to 4 KB. '
    + 'For large outputs, redirect to a file and read specific ranges. '
    + `Set timeout_seconds > ${backgroundTask.backgroundThresholdSec} for long-running commands — they run as background tasks and return immediately with a task ID.`,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute.' },
        timeout_seconds: {
          type: 'number',
          description: `Timeout in seconds. Commands with timeout > ${backgroundTask.backgroundThresholdSec}s run as background tasks and return immediately with a task ID. Short commands (e.g. ls, cat) typically need 5-10s; builds or tests may need 60-300s.`,
        },
        intention: { type: 'string', description: 'Brief description of what this command does (shown in background task status).' },
      },
      required: ['command', 'timeout_seconds'],
    },
    execute: async input => {
      const { command, timeout_seconds, intention } = input as { command: string; timeout_seconds: number; intention?: string };
      const timeoutSec = timeout_seconds;
      const pseudoResult = backgroundTask.pseudoCommands
        ? executePseudoCommand(command, backgroundTask.pseudoCommands)
        : null;
      if (pseudoResult) {
        return {
          content: JSON.stringify({ exit_code: pseudoResult.exitCode, output: pseudoResult.output, truncated: false }),
          requiresFollowUp: true,
        };
      }

      // Background task path
      if (timeoutSec > backgroundTask.backgroundThresholdSec) {
        const taskId = backgroundTask.startTask(
          'shell_execute',
          backgroundTask.sessionId,
          { command, shell: runtime.shell },
          intention,
          timeoutSec * 1000,
        );
        return {
          content: JSON.stringify({ background_task_id: taskId, message: `Background task started (id: ${taskId}). You will be notified when it completes. Use kill_task to cancel or read_task_output to view results.` }),
          requiresFollowUp: true,
        };
      }

      // Synchronous execution path
      return await new Promise<ToolResult>(resolve => {
        const argv0 = extractArgv0(command);
        const rtkAvailable = checkRtk();
        const useRtkNative = backgroundTask.compactOutput && rtkAvailable && argv0 !== null && RTK_NATIVE_COMMANDS.has(argv0);
        const useRtkPipe = backgroundTask.compactOutput && rtkAvailable && !useRtkNative;
        const effectiveCommand = useRtkNative ? `rtk ${command}` : command;

        const child = execFile(
          runtime.shell[0]!,
          [...runtime.shell.slice(1), effectiveCommand],
          { timeout: Math.min(timeoutSec * 1000, BASH_TIMEOUT_MS), maxBuffer: BASH_MAX_OUTPUT * 2 },
          (error, stdout, stderr) => {
            const rawOutput = stdout + stderr;
            const finish = (output: string, wasTruncated: boolean) => {
              let final = output;
              let truncated = wasTruncated;
              if (final.length > BASH_MAX_OUTPUT) {
                final = final.slice(0, BASH_MAX_OUTPUT);
                // Don't split a surrogate pair — step back if the last char is a high surrogate.
                if (final.length > 0 && (final.charCodeAt(final.length - 1) & 0xFC00) === 0xD800)
                  final = final.slice(0, -1);
                truncated = true;
              }
              const exitCode = error ? (error as NodeJS.ErrnoException & { code?: string | number }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
                ? 'truncated'
                : (child.exitCode ?? 1)
                : 0;
              resolve({
                content: JSON.stringify({ exit_code: exitCode, output: final, truncated }),
                requiresFollowUp: true,
              });
            };

            if (useRtkPipe && rawOutput.length > 0) {
              const rtkChild = spawn('rtk', ['pipe'], { stdio: ['pipe', 'pipe', 'pipe'] });
              let rtkOutput = '';
              rtkChild.stdout.on('data', (chunk: Buffer) => { rtkOutput += chunk.toString(); });
              rtkChild.on('close', code => {
                if (code === 0 && rtkOutput) {
                  finish(rtkOutput, false);
                } else {
                  finish(rawOutput, rawOutput.length > BASH_MAX_OUTPUT);
                }
              });
              rtkChild.on('error', () => {
                finish(rawOutput, rawOutput.length > BASH_MAX_OUTPUT);
              });
              rtkChild.stdin.write(rawOutput);
              rtkChild.stdin.end();
            } else {
              finish(rawOutput, false);
            }
          },
        );
      });
    },
  });
};
