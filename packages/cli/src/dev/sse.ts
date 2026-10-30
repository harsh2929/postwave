// SPDX-License-Identifier: MIT

import type { ServerResponse } from "node:http";

export interface SseClient {
  id: number;
  send(event: string, data: unknown): void;
  close(): void;
}

/**
 * Minimal SSE channel. The dev server registers each connected UI as
 * a client; the watcher and subject co-pilot push events via `broadcast`.
 */
export class SseChannel {
  private nextId = 1;
  private readonly clients = new Map<number, SseClient>();

  attach(res: ServerResponse): SseClient {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(":ok\n\n");
    const id = this.nextId++;
    const client: SseClient = {
      id,
      send: (event, data) => {
        try {
          res.write(`event: ${event}\n`);
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch {
          /* client gone */
        }
      },
      close: () => {
        this.clients.delete(id);
        try {
          res.end();
        } catch {
          /* already closed */
        }
      },
    };
    this.clients.set(id, client);
    res.on("close", () => this.clients.delete(id));
    return client;
  }

  broadcast(event: string, data: unknown): void {
    for (const c of this.clients.values()) c.send(event, data);
  }

  size(): number {
    return this.clients.size;
  }

  closeAll(): void {
    for (const c of this.clients.values()) c.close();
    this.clients.clear();
  }
}
