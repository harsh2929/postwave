// SPDX-License-Identifier: AGPL-3.0-only

import {
  getSmsCompliance,
  getSmsDiscountCodes,
  getSmsPilotReadiness,
  getSmsProgramRegions,
  getSmsSetup,
  getSmsTemplates,
  listSmsCampaigns,
  listSmsLists,
  listSmsSenderPilotCertifications,
  type SmsCampaign,
  type SmsComplianceStatus,
  type SmsDiscountCode,
  type SmsList,
  type SmsPilotReadiness,
  type SmsProgramRegion,
  type SmsSenderPilotCertification,
  type SmsSetupStatus,
  type SmsTemplate,
} from "@/lib/sms-api";

export type SmsPageData = {
  setup: SmsSetupStatus;
  compliance: SmsComplianceStatus;
  pilotReadiness: SmsPilotReadiness;
  lists: SmsList[];
  campaigns: SmsCampaign[];
  mmsReadiness: null;
  programRegions: SmsProgramRegion[];
  templates: SmsTemplate[];
  discountCodes: SmsDiscountCode[];
  creditBalance: null;
  senderCertifications: Record<string, SmsSenderPilotCertification>;
  supportingReadFailures: string[];
};

function supportingValue<T>(
  result: PromiseSettledResult<T>,
  label: string,
  failures: string[],
): T | null {
  if (result.status === "fulfilled") return result.value;
  failures.push(label);
  return null;
}

export async function loadSmsPageData(
  opts: { signal?: AbortSignal } = {},
): Promise<SmsPageData> {
  const [setup, compliance, pilotReadiness, lists, campaigns] =
    await Promise.all([
      getSmsSetup(opts),
      getSmsCompliance(opts),
      getSmsPilotReadiness(opts),
      listSmsLists(opts),
      listSmsCampaigns(opts),
    ]);
  const [nextRegions, nextTemplates, nextDiscountCodes] =
    await Promise.allSettled([
      getSmsProgramRegions(opts),
      getSmsTemplates(opts),
      getSmsDiscountCodes(undefined, opts),
    ]);
  const supportingReadFailures: string[] = [];
  const regions = supportingValue(
    nextRegions,
    "program regions",
    supportingReadFailures,
  );
  const templates = supportingValue(
    nextTemplates,
    "templates",
    supportingReadFailures,
  );
  const discountCodes = supportingValue(
    nextDiscountCodes,
    "discount codes",
    supportingReadFailures,
  );
  const senderCertifications: Record<string, SmsSenderPilotCertification> = {};
  try {
    const { items } = await listSmsSenderPilotCertifications(opts);
    for (const cert of items) {
      senderCertifications[cert.sender.id] = cert;
    }
  } catch {
    supportingReadFailures.push("sender pilot certifications");
  }

  return {
    setup,
    compliance,
    pilotReadiness,
    lists: lists.items,
    campaigns: campaigns.items,
    mmsReadiness: null,
    programRegions: regions?.items ?? [],
    templates: templates?.items ?? [],
    discountCodes: discountCodes?.items ?? [],
    creditBalance: null,
    senderCertifications,
    supportingReadFailures,
  };
}
