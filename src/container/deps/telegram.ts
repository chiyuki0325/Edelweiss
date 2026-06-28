import { startTelegram } from '../../telegram';
import type { Registrar } from '../registrar';
import { TOKENS } from '../tokens';

export default function registerTelegram({ get, register }: Registrar): void {
  register(TOKENS.TELEGRAM, () => {
    const manager = get(TOKENS.TELEGRAM_MANAGER);
    if (!manager) return undefined;
    return startTelegram({
      manager,
      driverHooks: get(TOKENS.TELEGRAM_DRIVER_HOOKS),
      liveHandlers: get(TOKENS.TELEGRAM_LIVE_HANDLERS),
      postStartupTasks: get(TOKENS.TELEGRAM_POST_STARTUP_TASKS),
    });
  });
}
