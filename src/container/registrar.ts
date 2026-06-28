import type { DependencyContainer } from 'tsyringe';

import type { Token } from './tokens';

export interface Registrar {
  c: DependencyContainer;
  get: <T>(tok: Token<T>) => T;
  register: <T>(tok: Token<T>, factory: (c: DependencyContainer) => T) => void;
}
