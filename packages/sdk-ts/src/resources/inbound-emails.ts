// SPDX-License-Identifier: MIT
import { Resource } from "./_base.js";

export interface InboundEmail {
  id: number;
  tenantId: string;
  subscriberId?: string;
  campaignId?: string;
  from: string;
  to: string;
  subject: string;
  messageId?: string;
  inReplyTo?: string;
  bodyText: string;
  bodyHtml: string;
  receivedAt: string;
}

export interface InboundEmailListPage {
  items: InboundEmail[];
}

export interface InboundEmailEndpoint {
  id: string;
  tenantId: string;
  slug: string;
  secretConfigured: boolean;
  rotationRequired: boolean;
  secretRotatedAt?: string;
  createdAt: string;
}

/** One-shot response from create/rotate. The secret is never returned by GET. */
export interface InboundEmailEndpointSecret extends InboundEmailEndpoint {
  secret: string;
}

export class InboundEmailsResource extends Resource {
  list(
    params: {
      subscriber_id?: string;
      campaign_id?: string;
      limit?: number;
    } = {},
  ): Promise<InboundEmailListPage> {
    return this.client.request("GET", "/api/v1/inbound-emails", {
      query: {
        subscriber_id: params.subscriber_id,
        campaign_id: params.campaign_id,
        limit: params.limit,
      },
    });
  }

  /** Return endpoint metadata only. A missing endpoint produces endpoint_not_found. */
  getEndpoint(): Promise<InboundEmailEndpoint> {
    return this.client.request("GET", "/api/v1/inbound-emails/endpoint");
  }

  /** Create or rotate the endpoint and reveal the new signing secret once. */
  rotateEndpoint(): Promise<InboundEmailEndpointSecret> {
    return this.client.request(
      "POST",
      "/api/v1/inbound-emails/endpoint/rotate",
    );
  }
}
