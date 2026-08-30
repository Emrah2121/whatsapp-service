import { config } from './config';
import { createLogger } from './logger';
import { SessionManager } from './sessions/SessionManager';
import { createApp } from './app';

const logger = createLogger('bootstrap');

async function main(): Promise<void> {
  const sessionManager = new SessionManager();

  await sessionManager.resumeAll();

  const app = createApp(sessionManager);
  const server = app.listen(config.port, () => {
    logger.info({ port: config.port }, 'whatsapp-service listening');
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    server.close(() => process.exit(0));
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  logger.error({ err: error instanceof Error ? error.message : error }, 'Fatal error during bootstrap');
  process.exit(1);
});
