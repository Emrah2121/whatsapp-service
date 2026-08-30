import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { verifyInternalSecret } from './middleware/verifyInternalSecret';
import { createLogger } from './logger';
import type { SessionManager } from './sessions/SessionManager';
import { createSessionsRouter } from './routes/sessions';

const logger = createLogger('http');

export function createApp(sessionManager: SessionManager): Express {
  const app = express();

  app.use(express.json());

  app.use((req: Request, _res: Response, next: NextFunction) => {
    logger.info({ method: req.method, path: req.path }, 'request');
    next();
  });

  app.get('/health', (_req, res) => {
    res.status(200).json({ success: true, message: '', data: { status: 'ok' }, errors: null });
  });

  app.use('/sessions', verifyInternalSecret, createSessionsRouter(sessionManager));

  app.use((req: Request, res: Response) => {
    res.status(404).json({ success: false, message: 'Not found.', data: null, errors: null });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err: err.message }, 'Unhandled error');
    res.status(500).json({ success: false, message: 'Internal server error.', data: null, errors: null });
  });

  return app;
}
