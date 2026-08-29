/**
 * SSE broadcaster with browser-session isolation.
 * Public market events may be broadcast to every client; account, engine, and
 * trade events must include a sessionId and are delivered only to that browser.
 */

const sseClients = new Map<any, string>();

export function addSSEClient(res: any, sessionId: string): void {
  sseClients.set(res, sessionId);
}

export function removeSSEClient(res: any): void {
  sseClients.delete(res);
}

export function broadcastSSE(event: string, data: unknown, sessionId?: string): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [res, clientSessionId] of sseClients) {
    if (sessionId && clientSessionId !== sessionId) continue;
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}
