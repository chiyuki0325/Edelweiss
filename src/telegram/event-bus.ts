import type { Logger } from '@guiiai/logg';

type Handler<T> = (event: T) => void;

export interface EventBus<T> {
  on: (handler: Handler<T>) => void;
  emit: (event: T) => void;
}

export const createEventBus = <T>(name: string, logger: Logger): EventBus<T> => {
  const handlers: Handler<T>[] = [];
  return {
    on: handler => { handlers.push(handler); },
    emit: event => {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch (err) {
          logger.withError(err).error(`${name} handler error`);
        }
      }
    },
  };
};
