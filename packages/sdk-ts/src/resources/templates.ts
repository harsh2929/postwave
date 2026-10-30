import { Resource } from "./_base.js";
import type { Template, TemplateCategory } from "../types.js";

export class TemplatesResource extends Resource {
  list(category?: TemplateCategory): Promise<Template[]> {
    return this.client.request("GET", "/api/v1/voice/templates", {
      query: category ? { category } : undefined,
    });
  }

  get(idOrSlug: string): Promise<Template> {
    return this.client.request("GET", `/api/v1/voice/templates/${encodeURIComponent(idOrSlug)}`);
  }

  create(t: Template): Promise<Template> {
    return this.client.request("POST", "/api/v1/voice/templates", { body: t });
  }

  update(idOrSlug: string, t: Partial<Template>): Promise<Template> {
    return this.client.request(
      "PATCH",
      `/api/v1/voice/templates/${encodeURIComponent(idOrSlug)}`,
      { body: t },
    );
  }

  delete(idOrSlug: string): Promise<void> {
    return this.client.request(
      "DELETE",
      `/api/v1/voice/templates/${encodeURIComponent(idOrSlug)}`,
    );
  }
}
