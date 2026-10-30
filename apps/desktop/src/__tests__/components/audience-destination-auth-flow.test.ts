import { describe, expect, it } from "vitest";

import { audienceDestinationConfigWithProviderDefaults } from "../../components/AudienceDestinationAuthFlow";

describe("AudienceDestinationAuthFlow config defaults", () => {
  it("defaults Google Ads destinations to the Data Manager Customer Match path", () => {
    const cfg = audienceDestinationConfigWithProviderDefaults("google_ads", {
      credential_ref: "vault://ads/google",
      customer_id: "123-456-7890",
      user_list_id: "999",
    });

    expect(cfg).toMatchObject({
      credential_ref: "vault://ads/google",
      customer_id: "123-456-7890",
      user_list_id: "999",
      customer_match_transport: "data_manager",
      customer_match_terms_accepted: false,
      ad_user_data_consent: "granted",
      ad_personalization_consent: "granted",
    });
  });

  it("preserves explicit Google Ads consent and terms choices", () => {
    const cfg = audienceDestinationConfigWithProviderDefaults("google_ads", {
      customer_match_terms_accepted: true,
      ad_user_data_consent: "denied",
      ad_personalization_consent: "denied",
    });

    expect(cfg.customer_match_terms_accepted).toBe(true);
    expect(cfg.ad_user_data_consent).toBe("denied");
    expect(cfg.ad_personalization_consent).toBe("denied");
  });

  it("does not add Google Ads fields to other audience providers", () => {
    const cfg = audienceDestinationConfigWithProviderDefaults("meta", {
      credential_ref: "vault://ads/meta",
    });

    expect(cfg).toEqual({ credential_ref: "vault://ads/meta" });
  });
});
