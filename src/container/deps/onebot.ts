import type { Registrar } from '../registrar';
import type { OneBotHolder } from '../tokens';
import { TOKENS } from '../tokens';

// OneBot handle holder — populated asynchronously by the orchestrator after
// startOneBot resolves its WS client.
export default function registerOnebot({ register }: Registrar): void {
  register(TOKENS.ONEBOT, (): OneBotHolder => ({ handle: undefined }));
}
