import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadConfig, resolveModel, type Config } from '../src/config/config';
import { setupLogger, useLogger } from '../src/config/logger';
import { runEvalSuite } from '../src/evals';
import type { EvalSuite } from '../src/evals';

const loadSuite = async (suitePath: string): Promise<EvalSuite> => {
  const mod = await import(pathToFileURL(suitePath).href) as {
    default?: EvalSuite | (() => EvalSuite | Promise<EvalSuite>);
  };
  if (!mod.default) throw new Error(`Eval suite ${suitePath} must export default`);
  return typeof mod.default === 'function' ? await mod.default() : mod.default;
};

const main = async () => {
  const suiteArg = process.argv[2];
  if (!suiteArg) {
    console.error('Usage: pnpm eval <suite.ts>');
    process.exitCode = 1;
    return;
  }

  setupLogger();
  const log = useLogger('eval');
  const suitePath = resolve(process.cwd(), suiteArg);
  const suite = await loadSuite(suitePath);
  let config: Config | undefined;
  const { results, outputDir } = await runEvalSuite({
    suite,
    suitePath,
    resolveModel: name => {
      config ??= loadConfig();
      return resolveModel(config, name);
    },
    log,
  });

  const passed = results.filter(r => r.evaluation.passed).length;
  console.log(`Eval complete: ${passed}/${results.length} passed`);
  console.log(`Results: ${outputDir}`);
};

void main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
