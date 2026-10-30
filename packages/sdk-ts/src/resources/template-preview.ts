import { Resource } from "./_base.js";

export interface TemplatePreviewInput {
  template: string;
  vars?: Record<string, unknown>;
}

export interface TemplatePreviewResponse {
  rendered: string;
}

/**
 * Preview an MJML / HTML email template that uses the lightweight
 * conditional-block syntax:
 *
 *   {{#if subscriber.tier == "pro"}}A{{else}}B{{/if}}
 *   {{#if has subscriber.tag "vip"}}VIP{{/if}}
 */
export class TemplatePreviewResource extends Resource {
  preview(input: TemplatePreviewInput): Promise<TemplatePreviewResponse> {
    return this.client.request("POST", "/api/v1/templates/preview", {
      body: { template: input.template, vars: input.vars ?? {} },
    });
  }

  /** Same call, exposed under a `render` alias to match the MCP tool name. */
  render(input: TemplatePreviewInput): Promise<TemplatePreviewResponse> {
    return this.preview(input);
  }
}
