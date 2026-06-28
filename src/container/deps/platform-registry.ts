import { createPlatformRegistry } from '../../startup/platform-registry';
import type { Registrar } from '../registrar';
import { TOKENS } from '../tokens';

export default function registerPlatformRegistry({ register }: Registrar): void {
  register(TOKENS.PLATFORM_REGISTRY, () => createPlatformRegistry());
}
