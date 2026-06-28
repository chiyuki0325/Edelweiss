import { resolveRuntime } from '../../config/config';
import type { Registrar } from '../registrar';
import { TOKENS } from '../tokens';

export default function registerRuntimeConfig({ get, register }: Registrar): void {
  register(TOKENS.RUNTIME_CONFIG, () => {
    const runtimeConfig = resolveRuntime(get(TOKENS.CONFIG));
    if (runtimeConfig.shell.length === 0)
      throw new Error('runtime.shell must be configured');
    if (!runtimeConfig.writeFile || runtimeConfig.writeFile.length === 0)
      throw new Error('runtime.writeFile must be configured');
    if (!runtimeConfig.readFile || runtimeConfig.readFile.length === 0)
      throw new Error('runtime.readFile must be configured');
    return runtimeConfig;
  });
}
