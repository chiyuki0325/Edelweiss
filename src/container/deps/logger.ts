import { useLogger } from '../../config/logger';
import type { Registrar } from '../registrar';
import { TOKENS } from '../tokens';

const logger = useLogger('edelweiss');

export default function registerLogger({ register }: Registrar): void {
  register(TOKENS.LOGGER, () => logger);
}
