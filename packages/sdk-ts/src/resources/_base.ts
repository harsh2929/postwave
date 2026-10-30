import type { PostwaveClient } from "../client.js";

/** Base class every resource extends — just holds a client reference. */
export abstract class Resource {
  protected readonly client: PostwaveClient;
  constructor(client: PostwaveClient) {
    this.client = client;
  }
}
