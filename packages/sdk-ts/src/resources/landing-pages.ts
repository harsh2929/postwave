// SPDX-License-Identifier: MIT
import { Resource } from "./_base.js";

export type LandingPageStatus = "draft" | "published" | "archived";

export interface LandingPage {
  id: string;
  tenant_id: string;
  slug: string;
  name: string;
  status: LandingPageStatus;
  domain?: string;
  template: string;
  blocks: Array<Record<string, unknown>>;
  seo: Record<string, unknown>;
  tracking: Record<string, unknown>;
  metrics: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CreateLandingPageInput {
  /** Lowercase alphanumeric + hyphen; must start with a letter; max 64. */
  slug: string;
  name: string;
  domain?: string;
  template?: string;
  blocks?: Array<Record<string, unknown>>;
  seo?: Record<string, unknown>;
  tracking?: Record<string, unknown>;
}

export interface UpdateLandingPageInput {
  name?: string;
  status?: LandingPageStatus;
  domain?: string;
  template?: string;
  blocks?: Array<Record<string, unknown>>;
  seo?: Record<string, unknown>;
  tracking?: Record<string, unknown>;
}

export class LandingPagesResource extends Resource {
  list(): Promise<LandingPage[]> {
    return this.client.request("GET", "/api/v1/landing-pages");
  }

  get(id: string): Promise<LandingPage> {
    return this.client.request("GET", `/api/v1/landing-pages/${encodeURIComponent(id)}`);
  }

  create(input: CreateLandingPageInput): Promise<LandingPage> {
    return this.client.request("POST", "/api/v1/landing-pages", { body: input });
  }

  update(id: string, input: UpdateLandingPageInput): Promise<LandingPage> {
    return this.client.request(
      "PATCH",
      `/api/v1/landing-pages/${encodeURIComponent(id)}`,
      { body: input },
    );
  }

  /** Soft archive — flips status to "archived". Hard-delete is intentionally not exposed. */
  archive(id: string): Promise<{ ok: boolean }> {
    return this.client.request(
      "DELETE",
      `/api/v1/landing-pages/${encodeURIComponent(id)}`,
    );
  }
}
