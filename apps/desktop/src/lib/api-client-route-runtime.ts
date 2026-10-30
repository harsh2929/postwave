/**
 * Route-only API runtime.
 *
 * These method factories previously initialized inside api-client.ts, making
 * every routed transport part of the renderer's cold-start modulepreload.
 * The public facade retains the exact promise-returning method contract, but
 * this implementation is fetched only when a routed method is actually
 * called (navigation, record search, or a route-owned background refresh).
 */
import {
  routeApiRequest,
  routeBuildStreamUrl,
  routeGetApiUrl,
  routeGetTenantId,
  routeQueueableApiRequest,
} from "./api-client-request-bridge";
import { createAeoOperationsMethods } from "./api/aeo-operations";
import { createAgencyOperationsMethods } from "./api/agency-operations";
import { createAiRegressionOperationsMethods } from "./api/ai-regression-operations";
import { createArchiveReferralOperationsMethods } from "./api/archive-referral-operations";
import { createAuditDeliveryOperationsMethods } from "./api/audit-delivery-operations";
import { createDomainDeliverabilityOperationsMethods } from "./api/domain-deliverability-operations";
import { createEnterpriseGovernanceOperationsMethods } from "./api/enterprise-governance-operations";
import { createListTagOperationsMethods } from "./api/list-tag-operations";
import { createSmsInboxOperationsMethods } from "./api/sms-inbox-operations";
import { createSubscriberProfilesApis } from "./api/subscriber-profiles";
import { createWebhookEventOperationsMethods } from "./api/webhook-event-operations";

const auditDelivery = createAuditDeliveryOperationsMethods({
  request: routeApiRequest,
});
const { subscriberDirectoryMethods, subscriberProfileMethods } =
  createSubscriberProfilesApis(routeApiRequest, routeQueueableApiRequest);
const webhookEvents = createWebhookEventOperationsMethods({
  request: routeApiRequest,
  getApiUrl: routeGetApiUrl,
  buildStreamUrl: routeBuildStreamUrl,
});
const smsInbox = createSmsInboxOperationsMethods({
  request: routeApiRequest,
  getApiUrl: routeGetApiUrl,
  getTenantId: routeGetTenantId,
});
const listTags = createListTagOperationsMethods({
  request: routeApiRequest,
  queueableRequest: routeQueueableApiRequest,
});
const archiveReferrals = createArchiveReferralOperationsMethods({
  request: routeApiRequest,
});
const domainDeliverability = createDomainDeliverabilityOperationsMethods({
  request: routeApiRequest,
});
const enterpriseGovernance = createEnterpriseGovernanceOperationsMethods({
  request: routeApiRequest,
});
const aeo = createAeoOperationsMethods({ request: routeApiRequest });
const agency = createAgencyOperationsMethods({ request: routeApiRequest });
const aiRegression = createAiRegressionOperationsMethods({
  request: routeApiRequest,
});

export const deferredRouteApi = {
  ...auditDelivery,
  ...subscriberDirectoryMethods,
  ...subscriberProfileMethods,
  ...webhookEvents,
  ...smsInbox,
  ...listTags,
  ...archiveReferrals,
  ...domainDeliverability,
  ...enterpriseGovernance,
  ...aeo,
  ...agency,
  ...aiRegression,
};

export type DeferredRouteApi = typeof deferredRouteApi;
