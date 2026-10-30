// SPDX-License-Identifier: AGPL-3.0-only
//
// GENERATED FILE — do not edit.
//
// Source: packages/openapi/surfaces/openapi.yaml
// Regenerate: node packages/sdk-ts/scripts/generate-operations.mjs
// CI drift gate: the same script with --check.
//
// Each operation contributes its method, its path TEMPLATE, and three type
// aliases indexing into the generated `paths` tree. An alias resolves to
// `never` when the operation has no such part — a body-less GET has
// `Body = never`, which is a compile error at the call site rather than an
// `any` that silently accepts anything.

import type { paths } from "./paths.js";

/** `GET /api/v1/subscribers` */
export type ListSubscribersQuery = paths["/api/v1/subscribers"]["get"] extends {
  parameters: { query?: infer Q };
}
  ? Q
  : never;
export type ListSubscribersBody = paths["/api/v1/subscribers"]["get"] extends {
  requestBody: { content: { "application/json": infer B } };
}
  ? B
  : never;
export type ListSubscribersResponse = paths["/api/v1/subscribers"]["get"] extends {
  responses: { 200: { content: { "application/json": infer R } } };
}
  ? R
  : never;

/** `POST /api/v1/subscribers` */
export type CreateSubscriberQuery = paths["/api/v1/subscribers"]["post"] extends {
  parameters: { query?: infer Q };
}
  ? Q
  : never;
export type CreateSubscriberBody = paths["/api/v1/subscribers"]["post"] extends {
  requestBody: { content: { "application/json": infer B } };
}
  ? B
  : never;
export type CreateSubscriberResponse = paths["/api/v1/subscribers"]["post"] extends {
  responses: { 200: { content: { "application/json": infer R } } };
}
  ? R
  : never;

/** `GET /api/v1/subscribers/{id}` */
export type GetSubscriberQuery = paths["/api/v1/subscribers/{id}"]["get"] extends {
  parameters: { query?: infer Q };
}
  ? Q
  : never;
export type GetSubscriberBody = paths["/api/v1/subscribers/{id}"]["get"] extends {
  requestBody: { content: { "application/json": infer B } };
}
  ? B
  : never;
export type GetSubscriberResponse = paths["/api/v1/subscribers/{id}"]["get"] extends {
  responses: { 200: { content: { "application/json": infer R } } };
}
  ? R
  : never;

/** `PATCH /api/v1/subscribers/{id}` */
export type UpdateSubscriberQuery = paths["/api/v1/subscribers/{id}"]["patch"] extends {
  parameters: { query?: infer Q };
}
  ? Q
  : never;
export type UpdateSubscriberBody = paths["/api/v1/subscribers/{id}"]["patch"] extends {
  requestBody: { content: { "application/json": infer B } };
}
  ? B
  : never;
export type UpdateSubscriberResponse = paths["/api/v1/subscribers/{id}"]["patch"] extends {
  responses: { 200: { content: { "application/json": infer R } } };
}
  ? R
  : never;

/** `DELETE /api/v1/subscribers/{id}` */
export type DeleteSubscriberQuery = paths["/api/v1/subscribers/{id}"]["delete"] extends {
  parameters: { query?: infer Q };
}
  ? Q
  : never;
export type DeleteSubscriberBody = paths["/api/v1/subscribers/{id}"]["delete"] extends {
  requestBody: { content: { "application/json": infer B } };
}
  ? B
  : never;
export type DeleteSubscriberResponse = paths["/api/v1/subscribers/{id}"]["delete"] extends {
  responses: { 200: { content: { "application/json": infer R } } };
}
  ? R
  : never;

/** `GET /api/v1/subscribers/search` */
export type SearchSubscribersQuery = paths["/api/v1/subscribers/search"]["get"] extends {
  parameters: { query?: infer Q };
}
  ? Q
  : never;
export type SearchSubscribersBody = paths["/api/v1/subscribers/search"]["get"] extends {
  requestBody: { content: { "application/json": infer B } };
}
  ? B
  : never;
export type SearchSubscribersResponse = paths["/api/v1/subscribers/search"]["get"] extends {
  responses: { 200: { content: { "application/json": infer R } } };
}
  ? R
  : never;

/** `POST /api/v1/subscribers/{id}/suppress` */
export type SuppressSubscriberQuery = paths["/api/v1/subscribers/{id}/suppress"]["post"] extends {
  parameters: { query?: infer Q };
}
  ? Q
  : never;
export type SuppressSubscriberBody = paths["/api/v1/subscribers/{id}/suppress"]["post"] extends {
  requestBody: { content: { "application/json": infer B } };
}
  ? B
  : never;
export type SuppressSubscriberResponse = paths["/api/v1/subscribers/{id}/suppress"]["post"] extends {
  responses: { 200: { content: { "application/json": infer R } } };
}
  ? R
  : never;

/** `GET /api/v1/profile-transform-rules` */
export type ListProfileTransformRulesQuery = paths["/api/v1/profile-transform-rules"]["get"] extends {
  parameters: { query?: infer Q };
}
  ? Q
  : never;
export type ListProfileTransformRulesBody = paths["/api/v1/profile-transform-rules"]["get"] extends {
  requestBody: { content: { "application/json": infer B } };
}
  ? B
  : never;
export type ListProfileTransformRulesResponse = paths["/api/v1/profile-transform-rules"]["get"] extends {
  responses: { 200: { content: { "application/json": infer R } } };
}
  ? R
  : never;

/** `POST /api/v1/profile-transform-rules` */
export type UpsertProfileTransformRuleQuery = paths["/api/v1/profile-transform-rules"]["post"] extends {
  parameters: { query?: infer Q };
}
  ? Q
  : never;
export type UpsertProfileTransformRuleBody = paths["/api/v1/profile-transform-rules"]["post"] extends {
  requestBody: { content: { "application/json": infer B } };
}
  ? B
  : never;
export type UpsertProfileTransformRuleResponse = paths["/api/v1/profile-transform-rules"]["post"] extends {
  responses: { 200: { content: { "application/json": infer R } } };
}
  ? R
  : never;

/** `DELETE /api/v1/profile-transform-rules/{id}` */
export type DeleteProfileTransformRuleQuery = paths["/api/v1/profile-transform-rules/{id}"]["delete"] extends {
  parameters: { query?: infer Q };
}
  ? Q
  : never;
export type DeleteProfileTransformRuleBody = paths["/api/v1/profile-transform-rules/{id}"]["delete"] extends {
  requestBody: { content: { "application/json": infer B } };
}
  ? B
  : never;
export type DeleteProfileTransformRuleResponse = paths["/api/v1/profile-transform-rules/{id}"]["delete"] extends {
  responses: { 200: { content: { "application/json": infer R } } };
}
  ? R
  : never;

/** `GET /api/v1/lists` */
export type ListListsQuery = paths["/api/v1/lists"]["get"] extends {
  parameters: { query?: infer Q };
}
  ? Q
  : never;
export type ListListsBody = paths["/api/v1/lists"]["get"] extends {
  requestBody: { content: { "application/json": infer B } };
}
  ? B
  : never;
export type ListListsResponse = paths["/api/v1/lists"]["get"] extends {
  responses: { 200: { content: { "application/json": infer R } } };
}
  ? R
  : never;

/** `POST /api/v1/lists` */
export type CreateListQuery = paths["/api/v1/lists"]["post"] extends {
  parameters: { query?: infer Q };
}
  ? Q
  : never;
export type CreateListBody = paths["/api/v1/lists"]["post"] extends {
  requestBody: { content: { "application/json": infer B } };
}
  ? B
  : never;
export type CreateListResponse = paths["/api/v1/lists"]["post"] extends {
  responses: { 200: { content: { "application/json": infer R } } };
}
  ? R
  : never;

/** `GET /api/v1/lists/for-subscriber/{sub_id}` */
export type ListListsForSubscriberQuery = paths["/api/v1/lists/for-subscriber/{sub_id}"]["get"] extends {
  parameters: { query?: infer Q };
}
  ? Q
  : never;
export type ListListsForSubscriberBody = paths["/api/v1/lists/for-subscriber/{sub_id}"]["get"] extends {
  requestBody: { content: { "application/json": infer B } };
}
  ? B
  : never;
export type ListListsForSubscriberResponse = paths["/api/v1/lists/for-subscriber/{sub_id}"]["get"] extends {
  responses: { 200: { content: { "application/json": infer R } } };
}
  ? R
  : never;

/** `PATCH /api/v1/lists/{id}` */
export type UpdateListQuery = paths["/api/v1/lists/{id}"]["patch"] extends {
  parameters: { query?: infer Q };
}
  ? Q
  : never;
export type UpdateListBody = paths["/api/v1/lists/{id}"]["patch"] extends {
  requestBody: { content: { "application/json": infer B } };
}
  ? B
  : never;
export type UpdateListResponse = paths["/api/v1/lists/{id}"]["patch"] extends {
  responses: { 200: { content: { "application/json": infer R } } };
}
  ? R
  : never;

/** `DELETE /api/v1/lists/{id}` */
export type DeleteListQuery = paths["/api/v1/lists/{id}"]["delete"] extends {
  parameters: { query?: infer Q };
}
  ? Q
  : never;
export type DeleteListBody = paths["/api/v1/lists/{id}"]["delete"] extends {
  requestBody: { content: { "application/json": infer B } };
}
  ? B
  : never;
export type DeleteListResponse = paths["/api/v1/lists/{id}"]["delete"] extends {
  responses: { 200: { content: { "application/json": infer R } } };
}
  ? R
  : never;

/** `GET /api/v1/campaigns` */
export type ListCampaignsQuery = paths["/api/v1/campaigns"]["get"] extends {
  parameters: { query?: infer Q };
}
  ? Q
  : never;
export type ListCampaignsBody = paths["/api/v1/campaigns"]["get"] extends {
  requestBody: { content: { "application/json": infer B } };
}
  ? B
  : never;
export type ListCampaignsResponse = paths["/api/v1/campaigns"]["get"] extends {
  responses: { 200: { content: { "application/json": infer R } } };
}
  ? R
  : never;

/** `POST /api/v1/campaigns` */
export type CreateCampaignQuery = paths["/api/v1/campaigns"]["post"] extends {
  parameters: { query?: infer Q };
}
  ? Q
  : never;
export type CreateCampaignBody = paths["/api/v1/campaigns"]["post"] extends {
  requestBody: { content: { "application/json": infer B } };
}
  ? B
  : never;
export type CreateCampaignResponse = paths["/api/v1/campaigns"]["post"] extends {
  responses: { 200: { content: { "application/json": infer R } } };
}
  ? R
  : never;

/** `GET /api/v1/campaigns/{id}` */
export type GetCampaignQuery = paths["/api/v1/campaigns/{id}"]["get"] extends {
  parameters: { query?: infer Q };
}
  ? Q
  : never;
export type GetCampaignBody = paths["/api/v1/campaigns/{id}"]["get"] extends {
  requestBody: { content: { "application/json": infer B } };
}
  ? B
  : never;
export type GetCampaignResponse = paths["/api/v1/campaigns/{id}"]["get"] extends {
  responses: { 200: { content: { "application/json": infer R } } };
}
  ? R
  : never;

/** `PATCH /api/v1/campaigns/{id}` */
export type UpdateCampaignQuery = paths["/api/v1/campaigns/{id}"]["patch"] extends {
  parameters: { query?: infer Q };
}
  ? Q
  : never;
export type UpdateCampaignBody = paths["/api/v1/campaigns/{id}"]["patch"] extends {
  requestBody: { content: { "application/json": infer B } };
}
  ? B
  : never;
export type UpdateCampaignResponse = paths["/api/v1/campaigns/{id}"]["patch"] extends {
  responses: { 200: { content: { "application/json": infer R } } };
}
  ? R
  : never;

/** `DELETE /api/v1/campaigns/{id}` */
export type DeleteCampaignQuery = paths["/api/v1/campaigns/{id}"]["delete"] extends {
  parameters: { query?: infer Q };
}
  ? Q
  : never;
export type DeleteCampaignBody = paths["/api/v1/campaigns/{id}"]["delete"] extends {
  requestBody: { content: { "application/json": infer B } };
}
  ? B
  : never;
export type DeleteCampaignResponse = paths["/api/v1/campaigns/{id}"]["delete"] extends {
  responses: { 200: { content: { "application/json": infer R } } };
}
  ? R
  : never;

/** `POST /api/v1/campaigns/{id}/send` */
export type SendCampaignQuery = paths["/api/v1/campaigns/{id}/send"]["post"] extends {
  parameters: { query?: infer Q };
}
  ? Q
  : never;
export type SendCampaignBody = paths["/api/v1/campaigns/{id}/send"]["post"] extends {
  requestBody: { content: { "application/json": infer B } };
}
  ? B
  : never;
export type SendCampaignResponse = paths["/api/v1/campaigns/{id}/send"]["post"] extends {
  responses: { 200: { content: { "application/json": infer R } } };
}
  ? R
  : never;

/** `GET /api/v1/campaigns/{id}/report` */
export type GetCampaignReportQuery = paths["/api/v1/campaigns/{id}/report"]["get"] extends {
  parameters: { query?: infer Q };
}
  ? Q
  : never;
export type GetCampaignReportBody = paths["/api/v1/campaigns/{id}/report"]["get"] extends {
  requestBody: { content: { "application/json": infer B } };
}
  ? B
  : never;
export type GetCampaignReportResponse = paths["/api/v1/campaigns/{id}/report"]["get"] extends {
  responses: { 200: { content: { "application/json": infer R } } };
}
  ? R
  : never;

/** `GET /api/v1/archive` */
export type ListArchiveQuery = paths["/api/v1/archive"]["get"] extends {
  parameters: { query?: infer Q };
}
  ? Q
  : never;
export type ListArchiveBody = paths["/api/v1/archive"]["get"] extends {
  requestBody: { content: { "application/json": infer B } };
}
  ? B
  : never;
export type ListArchiveResponse = paths["/api/v1/archive"]["get"] extends {
  responses: { 200: { content: { "application/json": infer R } } };
}
  ? R
  : never;

/** `GET /api/public/archive/{tenant_slug}` */
export type GetPublicArchiveQuery = paths["/api/public/archive/{tenant_slug}"]["get"] extends {
  parameters: { query?: infer Q };
}
  ? Q
  : never;
export type GetPublicArchiveBody = paths["/api/public/archive/{tenant_slug}"]["get"] extends {
  requestBody: { content: { "application/json": infer B } };
}
  ? B
  : never;
export type GetPublicArchiveResponse = paths["/api/public/archive/{tenant_slug}"]["get"] extends {
  responses: { 200: { content: { "application/json": infer R } } };
}
  ? R
  : never;

/** `GET /api/public/archive/{tenant_slug}/{campaign_slug}` */
export type GetPublicArchiveEntryQuery = paths["/api/public/archive/{tenant_slug}/{campaign_slug}"]["get"] extends {
  parameters: { query?: infer Q };
}
  ? Q
  : never;
export type GetPublicArchiveEntryBody = paths["/api/public/archive/{tenant_slug}/{campaign_slug}"]["get"] extends {
  requestBody: { content: { "application/json": infer B } };
}
  ? B
  : never;
export type GetPublicArchiveEntryResponse = paths["/api/public/archive/{tenant_slug}/{campaign_slug}"]["get"] extends {
  responses: { 200: { content: { "application/json": infer R } } };
}
  ? R
  : never;

/** `GET /api/v1/send-time-opt` */
export type GetSegmentBestSendTimeQuery = paths["/api/v1/send-time-opt"]["get"] extends {
  parameters: { query?: infer Q };
}
  ? Q
  : never;
export type GetSegmentBestSendTimeBody = paths["/api/v1/send-time-opt"]["get"] extends {
  requestBody: { content: { "application/json": infer B } };
}
  ? B
  : never;
export type GetSegmentBestSendTimeResponse = paths["/api/v1/send-time-opt"]["get"] extends {
  responses: { 200: { content: { "application/json": infer R } } };
}
  ? R
  : never;

/** `GET /api/v1/send-time-opt/heatmap` */
export type GetSegmentSendTimeHeatmapQuery = paths["/api/v1/send-time-opt/heatmap"]["get"] extends {
  parameters: { query?: infer Q };
}
  ? Q
  : never;
export type GetSegmentSendTimeHeatmapBody = paths["/api/v1/send-time-opt/heatmap"]["get"] extends {
  requestBody: { content: { "application/json": infer B } };
}
  ? B
  : never;
export type GetSegmentSendTimeHeatmapResponse = paths["/api/v1/send-time-opt/heatmap"]["get"] extends {
  responses: { 200: { content: { "application/json": infer R } } };
}
  ? R
  : never;

/**
 * Every curated operation, for callers that dispatch by id.
 *
 * Frozen so a consumer cannot mutate the route table at runtime and send a
 * request to a path the contract never described.
 */
export const OPERATIONS = Object.freeze({
  listSubscribers: Object.freeze({ method: "GET", path: "/api/v1/subscribers" }),
  createSubscriber: Object.freeze({ method: "POST", path: "/api/v1/subscribers" }),
  getSubscriber: Object.freeze({ method: "GET", path: "/api/v1/subscribers/{id}" }),
  updateSubscriber: Object.freeze({ method: "PATCH", path: "/api/v1/subscribers/{id}" }),
  deleteSubscriber: Object.freeze({ method: "DELETE", path: "/api/v1/subscribers/{id}" }),
  searchSubscribers: Object.freeze({ method: "GET", path: "/api/v1/subscribers/search" }),
  suppressSubscriber: Object.freeze({ method: "POST", path: "/api/v1/subscribers/{id}/suppress" }),
  listProfileTransformRules: Object.freeze({ method: "GET", path: "/api/v1/profile-transform-rules" }),
  upsertProfileTransformRule: Object.freeze({ method: "POST", path: "/api/v1/profile-transform-rules" }),
  deleteProfileTransformRule: Object.freeze({ method: "DELETE", path: "/api/v1/profile-transform-rules/{id}" }),
  listLists: Object.freeze({ method: "GET", path: "/api/v1/lists" }),
  createList: Object.freeze({ method: "POST", path: "/api/v1/lists" }),
  listListsForSubscriber: Object.freeze({ method: "GET", path: "/api/v1/lists/for-subscriber/{sub_id}" }),
  updateList: Object.freeze({ method: "PATCH", path: "/api/v1/lists/{id}" }),
  deleteList: Object.freeze({ method: "DELETE", path: "/api/v1/lists/{id}" }),
  listCampaigns: Object.freeze({ method: "GET", path: "/api/v1/campaigns" }),
  createCampaign: Object.freeze({ method: "POST", path: "/api/v1/campaigns" }),
  getCampaign: Object.freeze({ method: "GET", path: "/api/v1/campaigns/{id}" }),
  updateCampaign: Object.freeze({ method: "PATCH", path: "/api/v1/campaigns/{id}" }),
  deleteCampaign: Object.freeze({ method: "DELETE", path: "/api/v1/campaigns/{id}" }),
  sendCampaign: Object.freeze({ method: "POST", path: "/api/v1/campaigns/{id}/send" }),
  getCampaignReport: Object.freeze({ method: "GET", path: "/api/v1/campaigns/{id}/report" }),
  listArchive: Object.freeze({ method: "GET", path: "/api/v1/archive" }),
  getPublicArchive: Object.freeze({ method: "GET", path: "/api/public/archive/{tenant_slug}" }),
  getPublicArchiveEntry: Object.freeze({ method: "GET", path: "/api/public/archive/{tenant_slug}/{campaign_slug}" }),
  getSegmentBestSendTime: Object.freeze({ method: "GET", path: "/api/v1/send-time-opt" }),
  getSegmentSendTimeHeatmap: Object.freeze({ method: "GET", path: "/api/v1/send-time-opt/heatmap" }),
} as const);

export type OperationId = keyof typeof OPERATIONS;

/** The transport this client needs. `PostwaveClient` satisfies it. */
export interface OperationTransport {
  request<T>(
    method: string,
    path: string,
    opts?: { query?: Record<string, unknown>; body?: unknown },
  ): Promise<T>;
}

/**
 * Every curated operation as a typed call.
 *
 * Generated, so a method cannot call a path the contract does not
 * describe. The transport is the caller's — retry, idempotency, step-up
 * replay and error mapping all stay in `PostwaveClient.request`, which is
 * why generating these bodies reproduces none of it.
 */
export class GeneratedOperations {
  constructor(private readonly client: OperationTransport) {}

  /** `GET /api/v1/subscribers` */
  listSubscribers(opts: { query?: ListSubscribersQuery; body?: ListSubscribersBody } = {}): Promise<ListSubscribersResponse> {
    return this.client.request<ListSubscribersResponse>("GET", "/api/v1/subscribers", {
      query: opts.query as Record<string, unknown> | undefined,
      body: opts.body,
    });
  }

  /** `POST /api/v1/subscribers` */
  createSubscriber(opts: { query?: CreateSubscriberQuery; body?: CreateSubscriberBody } = {}): Promise<CreateSubscriberResponse> {
    return this.client.request<CreateSubscriberResponse>("POST", "/api/v1/subscribers", {
      query: opts.query as Record<string, unknown> | undefined,
      body: opts.body,
    });
  }

  /** `GET /api/v1/subscribers/{id}` */
  getSubscriber(id: string, opts: { query?: GetSubscriberQuery; body?: GetSubscriberBody } = {}): Promise<GetSubscriberResponse> {
    return this.client.request<GetSubscriberResponse>("GET", `/api/v1/subscribers/${encodeURIComponent(id)}`, {
      query: opts.query as Record<string, unknown> | undefined,
      body: opts.body,
    });
  }

  /** `PATCH /api/v1/subscribers/{id}` */
  updateSubscriber(id: string, opts: { query?: UpdateSubscriberQuery; body?: UpdateSubscriberBody } = {}): Promise<UpdateSubscriberResponse> {
    return this.client.request<UpdateSubscriberResponse>("PATCH", `/api/v1/subscribers/${encodeURIComponent(id)}`, {
      query: opts.query as Record<string, unknown> | undefined,
      body: opts.body,
    });
  }

  /** `DELETE /api/v1/subscribers/{id}` */
  deleteSubscriber(id: string, opts: { query?: DeleteSubscriberQuery; body?: DeleteSubscriberBody } = {}): Promise<DeleteSubscriberResponse> {
    return this.client.request<DeleteSubscriberResponse>("DELETE", `/api/v1/subscribers/${encodeURIComponent(id)}`, {
      query: opts.query as Record<string, unknown> | undefined,
      body: opts.body,
    });
  }

  /** `GET /api/v1/subscribers/search` */
  searchSubscribers(opts: { query?: SearchSubscribersQuery; body?: SearchSubscribersBody } = {}): Promise<SearchSubscribersResponse> {
    return this.client.request<SearchSubscribersResponse>("GET", "/api/v1/subscribers/search", {
      query: opts.query as Record<string, unknown> | undefined,
      body: opts.body,
    });
  }

  /** `POST /api/v1/subscribers/{id}/suppress` */
  suppressSubscriber(id: string, opts: { query?: SuppressSubscriberQuery; body?: SuppressSubscriberBody } = {}): Promise<SuppressSubscriberResponse> {
    return this.client.request<SuppressSubscriberResponse>("POST", `/api/v1/subscribers/${encodeURIComponent(id)}/suppress`, {
      query: opts.query as Record<string, unknown> | undefined,
      body: opts.body,
    });
  }

  /** `GET /api/v1/profile-transform-rules` */
  listProfileTransformRules(opts: { query?: ListProfileTransformRulesQuery; body?: ListProfileTransformRulesBody } = {}): Promise<ListProfileTransformRulesResponse> {
    return this.client.request<ListProfileTransformRulesResponse>("GET", "/api/v1/profile-transform-rules", {
      query: opts.query as Record<string, unknown> | undefined,
      body: opts.body,
    });
  }

  /** `POST /api/v1/profile-transform-rules` */
  upsertProfileTransformRule(opts: { query?: UpsertProfileTransformRuleQuery; body?: UpsertProfileTransformRuleBody } = {}): Promise<UpsertProfileTransformRuleResponse> {
    return this.client.request<UpsertProfileTransformRuleResponse>("POST", "/api/v1/profile-transform-rules", {
      query: opts.query as Record<string, unknown> | undefined,
      body: opts.body,
    });
  }

  /** `DELETE /api/v1/profile-transform-rules/{id}` */
  deleteProfileTransformRule(id: string, opts: { query?: DeleteProfileTransformRuleQuery; body?: DeleteProfileTransformRuleBody } = {}): Promise<DeleteProfileTransformRuleResponse> {
    return this.client.request<DeleteProfileTransformRuleResponse>("DELETE", `/api/v1/profile-transform-rules/${encodeURIComponent(id)}`, {
      query: opts.query as Record<string, unknown> | undefined,
      body: opts.body,
    });
  }

  /** `GET /api/v1/lists` */
  listLists(opts: { query?: ListListsQuery; body?: ListListsBody } = {}): Promise<ListListsResponse> {
    return this.client.request<ListListsResponse>("GET", "/api/v1/lists", {
      query: opts.query as Record<string, unknown> | undefined,
      body: opts.body,
    });
  }

  /** `POST /api/v1/lists` */
  createList(opts: { query?: CreateListQuery; body?: CreateListBody } = {}): Promise<CreateListResponse> {
    return this.client.request<CreateListResponse>("POST", "/api/v1/lists", {
      query: opts.query as Record<string, unknown> | undefined,
      body: opts.body,
    });
  }

  /** `GET /api/v1/lists/for-subscriber/{sub_id}` */
  listListsForSubscriber(sub_id: string, opts: { query?: ListListsForSubscriberQuery; body?: ListListsForSubscriberBody } = {}): Promise<ListListsForSubscriberResponse> {
    return this.client.request<ListListsForSubscriberResponse>("GET", `/api/v1/lists/for-subscriber/${encodeURIComponent(sub_id)}`, {
      query: opts.query as Record<string, unknown> | undefined,
      body: opts.body,
    });
  }

  /** `PATCH /api/v1/lists/{id}` */
  updateList(id: string, opts: { query?: UpdateListQuery; body?: UpdateListBody } = {}): Promise<UpdateListResponse> {
    return this.client.request<UpdateListResponse>("PATCH", `/api/v1/lists/${encodeURIComponent(id)}`, {
      query: opts.query as Record<string, unknown> | undefined,
      body: opts.body,
    });
  }

  /** `DELETE /api/v1/lists/{id}` */
  deleteList(id: string, opts: { query?: DeleteListQuery; body?: DeleteListBody } = {}): Promise<DeleteListResponse> {
    return this.client.request<DeleteListResponse>("DELETE", `/api/v1/lists/${encodeURIComponent(id)}`, {
      query: opts.query as Record<string, unknown> | undefined,
      body: opts.body,
    });
  }

  /** `GET /api/v1/campaigns` */
  listCampaigns(opts: { query?: ListCampaignsQuery; body?: ListCampaignsBody } = {}): Promise<ListCampaignsResponse> {
    return this.client.request<ListCampaignsResponse>("GET", "/api/v1/campaigns", {
      query: opts.query as Record<string, unknown> | undefined,
      body: opts.body,
    });
  }

  /** `POST /api/v1/campaigns` */
  createCampaign(opts: { query?: CreateCampaignQuery; body?: CreateCampaignBody } = {}): Promise<CreateCampaignResponse> {
    return this.client.request<CreateCampaignResponse>("POST", "/api/v1/campaigns", {
      query: opts.query as Record<string, unknown> | undefined,
      body: opts.body,
    });
  }

  /** `GET /api/v1/campaigns/{id}` */
  getCampaign(id: string, opts: { query?: GetCampaignQuery; body?: GetCampaignBody } = {}): Promise<GetCampaignResponse> {
    return this.client.request<GetCampaignResponse>("GET", `/api/v1/campaigns/${encodeURIComponent(id)}`, {
      query: opts.query as Record<string, unknown> | undefined,
      body: opts.body,
    });
  }

  /** `PATCH /api/v1/campaigns/{id}` */
  updateCampaign(id: string, opts: { query?: UpdateCampaignQuery; body?: UpdateCampaignBody } = {}): Promise<UpdateCampaignResponse> {
    return this.client.request<UpdateCampaignResponse>("PATCH", `/api/v1/campaigns/${encodeURIComponent(id)}`, {
      query: opts.query as Record<string, unknown> | undefined,
      body: opts.body,
    });
  }

  /** `DELETE /api/v1/campaigns/{id}` */
  deleteCampaign(id: string, opts: { query?: DeleteCampaignQuery; body?: DeleteCampaignBody } = {}): Promise<DeleteCampaignResponse> {
    return this.client.request<DeleteCampaignResponse>("DELETE", `/api/v1/campaigns/${encodeURIComponent(id)}`, {
      query: opts.query as Record<string, unknown> | undefined,
      body: opts.body,
    });
  }

  /** `POST /api/v1/campaigns/{id}/send` */
  sendCampaign(id: string, opts: { query?: SendCampaignQuery; body?: SendCampaignBody } = {}): Promise<SendCampaignResponse> {
    return this.client.request<SendCampaignResponse>("POST", `/api/v1/campaigns/${encodeURIComponent(id)}/send`, {
      query: opts.query as Record<string, unknown> | undefined,
      body: opts.body,
    });
  }

  /** `GET /api/v1/campaigns/{id}/report` */
  getCampaignReport(id: string, opts: { query?: GetCampaignReportQuery; body?: GetCampaignReportBody } = {}): Promise<GetCampaignReportResponse> {
    return this.client.request<GetCampaignReportResponse>("GET", `/api/v1/campaigns/${encodeURIComponent(id)}/report`, {
      query: opts.query as Record<string, unknown> | undefined,
      body: opts.body,
    });
  }

  /** `GET /api/v1/archive` */
  listArchive(opts: { query?: ListArchiveQuery; body?: ListArchiveBody } = {}): Promise<ListArchiveResponse> {
    return this.client.request<ListArchiveResponse>("GET", "/api/v1/archive", {
      query: opts.query as Record<string, unknown> | undefined,
      body: opts.body,
    });
  }

  /** `GET /api/public/archive/{tenant_slug}` */
  getPublicArchive(tenant_slug: string, opts: { query?: GetPublicArchiveQuery; body?: GetPublicArchiveBody } = {}): Promise<GetPublicArchiveResponse> {
    return this.client.request<GetPublicArchiveResponse>("GET", `/api/public/archive/${encodeURIComponent(tenant_slug)}`, {
      query: opts.query as Record<string, unknown> | undefined,
      body: opts.body,
    });
  }

  /** `GET /api/public/archive/{tenant_slug}/{campaign_slug}` */
  getPublicArchiveEntry(tenant_slug: string, campaign_slug: string, opts: { query?: GetPublicArchiveEntryQuery; body?: GetPublicArchiveEntryBody } = {}): Promise<GetPublicArchiveEntryResponse> {
    return this.client.request<GetPublicArchiveEntryResponse>("GET", `/api/public/archive/${encodeURIComponent(tenant_slug)}/${encodeURIComponent(campaign_slug)}`, {
      query: opts.query as Record<string, unknown> | undefined,
      body: opts.body,
    });
  }

  /** `GET /api/v1/send-time-opt` */
  getSegmentBestSendTime(opts: { query?: GetSegmentBestSendTimeQuery; body?: GetSegmentBestSendTimeBody } = {}): Promise<GetSegmentBestSendTimeResponse> {
    return this.client.request<GetSegmentBestSendTimeResponse>("GET", "/api/v1/send-time-opt", {
      query: opts.query as Record<string, unknown> | undefined,
      body: opts.body,
    });
  }

  /** `GET /api/v1/send-time-opt/heatmap` */
  getSegmentSendTimeHeatmap(opts: { query?: GetSegmentSendTimeHeatmapQuery; body?: GetSegmentSendTimeHeatmapBody } = {}): Promise<GetSegmentSendTimeHeatmapResponse> {
    return this.client.request<GetSegmentSendTimeHeatmapResponse>("GET", "/api/v1/send-time-opt/heatmap", {
      query: opts.query as Record<string, unknown> | undefined,
      body: opts.body,
    });
  }

}
