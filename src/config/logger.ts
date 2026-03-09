import { Format, initLogger, LogLevel, useGlobalLogger } from '@guiiai/logg';

export const setupLogger = () => {
  const isDev = process.env.NODE_ENV !== 'production';
  initLogger(
    isDev ? LogLevel.Debug : LogLevel.Log,
    isDev ? Format.Pretty : Format.JSON,
  );
};

export const useLogger = (context: string) => useGlobalLogger(context);
