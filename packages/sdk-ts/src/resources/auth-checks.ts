import { Resource } from "./_base.js";
import type { AuthCheck } from "../types.js";

export class AuthChecksResource extends Resource {
  list(): Promise<AuthCheck[]> {
    return this.client.request("GET", "/api/v1/auth-checks");
  }
}
