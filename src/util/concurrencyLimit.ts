/**
 * Runs `tasks` with at most `limit` running concurrently. Used only to
 * stagger boot-time session resumption so we don't open many WhatsApp
 * sockets at once - not a general-purpose queue, so no external dependency.
 */
export async function runWithConcurrencyLimit<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<void> {
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < tasks.length) {
      const index = cursor++;
      await tasks[index]();
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}
