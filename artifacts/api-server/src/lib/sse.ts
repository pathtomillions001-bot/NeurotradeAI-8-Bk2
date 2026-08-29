/**
 * Shared SSE broadcast module — imported by both ai.ts and trades.ts routes.
 * Keeps a Set of active response objects and fans out named events to all of them.
 */

const sseClients = new Set<any>();

export function addSSEClient(res: any): void {
  sseClients.add(res);
}

export function removeSSEClient(res: any): void {
  sseClients.delete(res);
}

export function broadcastSSE(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}
