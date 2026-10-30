import { Resource } from "./_base.js";
import type { Reputation } from "../types.js";

export class ReputationResource extends Resource {
  get(): Promise<Reputation> {
    return this.client.request("GET", "/api/v1/reputation");
  }
}
