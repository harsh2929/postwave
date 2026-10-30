import { Resource } from "./_base.js";
import type { SendingState, WarmupState } from "../types.js";

export class SendingResource extends Resource {
  getState(): Promise<SendingState> {
    return this.client.request("GET", "/api/v1/sending/state");
  }

  getWarmup(): Promise<WarmupState> {
    return this.client.request("GET", "/api/v1/sending/warmup");
  }
}
