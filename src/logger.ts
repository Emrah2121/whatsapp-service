import pino from 'pino';

const baseLogger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: process.env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty', options: { colorize: true } },
});

export function createLogger(name?: string) {
  return name ? baseLogger.child({ module: name }) : baseLogger;
}
