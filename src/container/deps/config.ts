import { loadConfig } from '../../config/config';
import type { Registrar } from '../registrar';
import { TOKENS } from '../tokens';

export default function registerConfig({ register }: Registrar): void {
  register(TOKENS.CONFIG, () => loadConfig());
}
