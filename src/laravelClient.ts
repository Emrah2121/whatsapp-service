import axios from 'axios';
import { config } from './config';
import { createLogger } from './logger';
import type { IncomingMessagePayload, StatusCallbackPayload } from './types';

const logger = createLogger('laravelClient');

const client = axios.create({
  baseURL: config.laravelApiBaseUrl,
  timeout: 5000,
  headers: { Authorization: `Bearer ${config.internalApiSecret}` },
});

// Per-company promise chains so status callbacks for the same company are
// always delivered in the order they were generated, even if the underlying
// HTTP calls resolve out of order (e.g. a "connecting" call is slow and
// would otherwise land after a later "connected" call). Incoming messages
// are independent events (each dedup'd by Laravel via whatsapp_message_id),
// so they deliberately do NOT share this queue - a slow message POST should
// never hold up a connection status update or vice versa.
const statusSendQueues = new Map<number, Promise<void>>();

function enqueue(queues: Map<number, Promise<void>>, companyId: number, task: () => Promise<void>): Promise<void> {
  const previous = queues.get(companyId) ?? Promise.resolve();
  const next = previous.then(task, task);
  queues.set(companyId, next);

  return next;
}

async function postWithRetry(path: string, body: unknown, logContext: Record<string, unknown>, attempts = 3): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await client.post(path, body);

      return;
    } catch (error) {
      const isLastAttempt = attempt === attempts;
      logger.warn(
        { ...logContext, attempt, err: error instanceof Error ? error.message : error },
        'Failed to call Laravel internal API',
      );

      if (isLastAttempt) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
}

export function postStatus(companyId: number, payload: StatusCallbackPayload): Promise<void> {
  return enqueue(statusSendQueues, companyId, () =>
    postWithRetry(`/internal/whatsapp/sessions/${companyId}/status`, payload, { companyId, status: payload.status }),
  );
}

export function postIncomingMessage(companyId: number, payload: IncomingMessagePayload): Promise<void> {
  return postWithRetry(`/internal/whatsapp/sessions/${companyId}/messages/incoming`, payload, { companyId });
}
