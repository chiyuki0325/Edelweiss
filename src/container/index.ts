import 'reflect-metadata';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { container as rootContainer } from 'tsyringe';
import type { DependencyContainer } from 'tsyringe';

import type { Registrar } from './registrar';
import type { Token } from './tokens';

export interface Container {
  container: DependencyContainer;
  get: <T>(tok: Token<T>) => T;
}

// tsyringe's FactoryProvider never caches, and its built-in instanceCachingFactory
// re-runs whenever a factory returns undefined (it tests `instance == undefined`).
// TELEGRAM legitimately resolves to `undefined`, so we memoize with an explicit
// presence flag to guarantee single construction even for undefined values.
const singleton = <T>(factory: (c: DependencyContainer) => T): ((c: DependencyContainer) => T) => {
  let cached: { value: T } | undefined;
  return c => {
    cached ??= { value: factory(c) };
    return cached.value;
  };
};

const depsDir = join(dirname(fileURLToPath(import.meta.url)), 'deps');

export const buildContainer = async (): Promise<Container> => {
  const c = rootContainer.createChildContainer();
  const get = <T>(tok: Token<T>): T => c.resolve<T>(tok.sym);
  const register = <T>(tok: Token<T>, factory: (c: DependencyContainer) => T) => {
    c.register<T>(tok.sym, { useFactory: singleton(factory) });
  };
  const registrar: Registrar = { c, get, register };

  const files = readdirSync(depsDir)
    .filter(f => f.endsWith('.ts'))
    .sort();

  for (const file of files) {
    const { default: registerDep } = await import(join(depsDir, file));
    registerDep(registrar);
  }

  return { container: c, get };
};
