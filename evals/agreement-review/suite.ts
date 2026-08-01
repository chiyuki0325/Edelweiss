import { createReactMessageTool } from '../../src/driver/tools';
import type { EvalRun, EvalSuite } from '../../src/evals';

const evaluator = (run: EvalRun) => {
  const reacted = run.toolCalls.some(call => call.name === 'react_message');
  const sentTexts = run.toolTrace.sentMessages.map(message => message.text);
  const sent = sentTexts.length > 0;
  const preservedSubstance = sentTexts.some(text =>
    text.includes('abort signal') && !text.includes('确实'));
  const substantive = run.icName === 'substantive-draft';
  const passed = substantive
    ? preservedSubstance && !reacted
    : reacted && !sent;

  return {
    passed,
    score: passed ? 1 : 0,
    labels: {
      reacted,
      sent,
      preservedSubstance,
      inappropriateReaction: substantive && reacted,
      textOnlyAgreement: !substantive && sent,
    },
    notes: `Sent: ${sentTexts.join(' | ') || '(none)'}; reacted: ${reacted}`,
  };
};

const suite: EvalSuite = {
  name: 'agreement-review-recovery',
  model: 'deepseek',
  repeats: 10,
  maxSteps: 2,
  scenarios: [{
    name: 'choose-rewrite-or-reaction',
    ic: './fixtures.ts',
    enabledTools: ['send_message', 'stay_silent'],
    lateBinding: {
      timeNow: '2026-08-01T12:00:00+08:00',
    },
    prompts: [{
      name: 'production',
      template: '../../prompts/primary-system.velin.md',
      params: {
        hasReactTool: true,
        availableReactionEmojis: ['👍', '❤️'],
      },
      systemFiles: ['../../prompts/IDENTITY.velin.md'],
    }],
    extraTools: () => [createReactMessageTool(['👍', '❤️'], async () => {})],
    evaluator,
  }],
};

export default suite;
