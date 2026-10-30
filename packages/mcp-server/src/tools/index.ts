// SPDX-License-Identifier: MIT
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { PostwaveClient } from "@postwave/sdk";

import { registerToolList, type AnyToolDef } from "../lib/register.js";
import { adminTools } from "./admin.js";
import { agentPrimitiveTools } from "./agent_primitives.js";
import { analyticsTools } from "./analytics.js";
import { audienceTools } from "./audience.js";
import { automationTools } from "./automations.js";
import { sendingSettingsTools } from "./sending-settings.js";
import { campaignTools } from "./campaigns.js";
import { campaignTemplateTools } from "./campaign-templates.js";
import { deliverabilityTools } from "./deliverability.js";
import { eventTools } from "./events.js";
import { formTools } from "./forms.js";
import { migrationTools } from "./migration.js";
import { subscriberTools } from "./subscribers.js";
import { topicTools } from "./topics.js";
import { voiceTools } from "./voice.js";
import { platformTools } from "./platform.js";
import { templateRenderTools } from "./template-render.js";
import { templateTools } from "./templates.js";
import { voiceDriftTools } from "./voice-drift.js";
import { accountTools } from "./account.js";
import { customDomainTools } from "./custom-domains.js";
import { linkCheckTools } from "./link-check.js";
import { archiveTools } from "./archive.js";
import { referralTools } from "./referrals.js";
import { discountTools } from "./discounts.js";
import { giftSubscriptionTools } from "./gift-subscriptions.js";
import { sendTimeTools } from "./send-time.js";
import { integrationTools } from "./integrations.js";
import { smsTools } from "./sms.js";
import { pushSuppressionTools } from "./push-suppressions.js";
import { developerMarketplaceTools } from "./developer-marketplace.js";
import { emailTools } from "./emails.js";

export function allTools(client: PostwaveClient): AnyToolDef[] {
  return [
    ...migrationTools(client),
    ...deliverabilityTools(client),
    ...voiceTools(client),
    ...subscriberTools(client),
    ...formTools(client),
    ...campaignTools(client),
    ...campaignTemplateTools(client),
    ...emailTools(client),
    ...automationTools(client),
    ...topicTools(client),
    ...adminTools(client),
    ...agentPrimitiveTools(client),
    ...eventTools(client),
    // X1+X2+X3 tool additions (12 new tool families).
    ...analyticsTools(client),
    ...audienceTools(client),
    ...sendingSettingsTools(client),
    ...platformTools(client),
    ...templateRenderTools(client),
    ...templateTools(client),
    ...voiceDriftTools(client),
    ...accountTools(client),
    ...customDomainTools(client),
    ...linkCheckTools(client),
    ...archiveTools(client),
    ...referralTools(client),
    ...discountTools(client),
    ...giftSubscriptionTools(client),
    ...sendTimeTools(client),
    ...integrationTools(client),
    ...smsTools(client),
    ...pushSuppressionTools(client),
    ...developerMarketplaceTools(client),
  ];
}

/** A smaller candidate surface for template-focused local agent review. */
export function toolsForProfile(
  client: PostwaveClient,
  profile: string | undefined,
): AnyToolDef[] {
  const tools = allTools(client);
  if (profile === "templates") {
    return tools.filter((tool) => tool.name.startsWith("campaign_template_"));
  }
  if (profile === undefined || profile === "full") return tools;
  throw new Error(`Unsupported MCP tool profile: ${profile}`);
}

export function registerTools(server: Server, client: PostwaveClient): void {
  registerToolList(
    server,
    toolsForProfile(client, process.env.MOOSEWAVE_MCP_PROFILE),
  );
}
