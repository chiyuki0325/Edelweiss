import { loadContacts } from '../../contacts';
import type { RenderParams } from '../../rendering';
import type { Registrar } from '../registrar';
import { TOKENS } from '../tokens';

export default function registerRenderParams({ get, register }: Registrar): void {
  register(TOKENS.RENDER_PARAMS, (): RenderParams => {
    const config = get(TOKENS.CONFIG);
    const botUserId = config.telegram != null ? config.telegram.botToken.split(':')[0]! : '0';
    return { botUserId, contactNames: loadContacts(get(TOKENS.LOGGER)) };
  });
}
