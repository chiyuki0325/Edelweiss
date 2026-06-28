import { resolveBackgroundTasks } from '../../config/config';
import type { Registrar } from '../registrar';
import { TOKENS } from '../tokens';

export default function registerBgTasksConfig({ get, register }: Registrar): void {
  register(TOKENS.BG_TASKS_CONFIG, () => resolveBackgroundTasks(get(TOKENS.CONFIG)));
}
