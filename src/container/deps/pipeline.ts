import { createPipeline } from '../../pipeline';
import type { Registrar } from '../registrar';
import { TOKENS } from '../tokens';

export default function registerPipeline({ get, register }: Registrar): void {
  register(TOKENS.PIPELINE, () => createPipeline(get(TOKENS.RENDER_PARAMS)));
}
