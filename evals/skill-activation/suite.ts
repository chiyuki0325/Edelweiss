import type { EvalRun, EvalSuite } from '../../src/evals';

const targetSkillName = 'netease-cloud-music';

const firstToolIndex = (run: EvalRun, toolName: string): number =>
  run.toolCalls.findIndex(call => call.name === toolName);

const evaluator = (run: EvalRun) => {
  const loadSkillIndex = firstToolIndex(run, 'load_skill');
  const sendMessageIndex = firstToolIndex(run, 'send_message');
  const calledLoadSkill = loadSkillIndex >= 0;
  const calledTargetSkill = run.toolTrace.loadedSkills.includes(targetSkillName);
  const calledBrowserUseSkill = run.toolTrace.loadedSkills.includes('browser-use');
  const sentMessage = run.toolTrace.sentMessages.length > 0;
  const loadedBeforeSend = calledLoadSkill && (sendMessageIndex < 0 || loadSkillIndex < sendMessageIndex);

  return {
    passed: calledTargetSkill,
    score: calledTargetSkill ? 1 : 0,
    labels: {
      calledLoadSkill,
      calledTargetSkill,
      calledBrowserUseSkill,
      sentMessage,
      loadedBeforeSend,
    },
    notes: calledTargetSkill
      ? `Loaded the matching ${targetSkillName} skill.`
      : `Loaded skills: ${run.toolTrace.loadedSkills.join(', ') || '(none)'}`,
  };
};

const identitySystemFiles = ['../../prompts/IDENTITY.velin.md'];

const suite: EvalSuite = {
  name: 'skill-activation-load-skill',
  model: 'deepseek',
  repeats: 10,
  maxSteps: 1,
  scenarios: [
    {
      name: 'netease-cloud-music-lyrics-request',
      ic: './fixture.ts',
      skillsFolder: './skills',
      enabledTools: ['send_message', 'dismiss_message', 'load_skill'],
      lateBinding: {
        timeNow: '2026-05-25T12:00:00+08:00',
        isMentioned: true,
      },
      prompts: [
        {
          name: 'before-skill-activation-guidance',
          template: './prompts/primary-system-before-skill-activation.velin.md',
          systemFiles: identitySystemFiles,
        },
        {
          name: 'after-skill-activation-guidance',
          template: '../../prompts/primary-system.velin.md',
          systemFiles: identitySystemFiles,
        },
      ],
      evaluator,
    },
  ],
};

export default suite;
