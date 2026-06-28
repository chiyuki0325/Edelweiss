import { resolveModel } from '../../config/config';
import { createSemaphore } from '../../media/llm-description';
import type { Registrar } from '../registrar';
import type { DescriptionSemaphores, Semaphore } from '../tokens';
import { TOKENS } from '../tokens';

export default function registerDescriptionSemaphores({ get, register }: Registrar): void {
  register(TOKENS.DESCRIPTION_SEMAPHORES, (): DescriptionSemaphores => {
    const config = get(TOKENS.CONFIG);
    const cache = new Map<string, Semaphore>();
    return {
      get: (modelKey: string | undefined): Semaphore | undefined => {
        if (!modelKey) return undefined;
        let sem = cache.get(modelKey);
        if (!sem) {
          const endpoint = resolveModel(config, modelKey);
          sem = createSemaphore(endpoint.descriptionConcurrency ?? 3);
          cache.set(modelKey, sem);
        }
        return sem;
      },
    };
  });
}
