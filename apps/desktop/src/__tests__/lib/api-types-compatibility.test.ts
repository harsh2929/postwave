import { describe, expect, it } from "vitest";

import type {
  ArchiveEntry,
  Campaign,
  CampaignPage,
  CampaignSendInput,
  PublicArchiveIndex,
  SendTimeOptHeatmap,
  SendTimeOptHeatmapCell,
  SendTimeOptSettings,
  SendTimeOptSettingsInput,
  SendTimeStrategy,
} from "../../lib/api-types";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? (<Value>() => Value extends Right ? 1 : 2) extends <
        Value,
      >() => Value extends Left ? 1 : 2
      ? true
      : false
    : false;

type Assert<Condition extends true> = Condition;

type ExpectedCampaignPage = {
  items?: Campaign[];
  total?: number;
  page?: number;
  per_page?: number;
};

type ExpectedCampaignSendInput = {
  scheduled_at?: string;
  send_now?: boolean;
};

type ExpectedArchiveEntry = {
  campaign_id: string;
  campaign_slug: string;
  subject: string;
  preview_text?: string;
  body_html?: string;
  published_at: string;
  tenant_slug?: string;
  permalink?: string;
};

type ExpectedPublicArchiveIndex = {
  tenant_slug?: string;
  title?: string;
  items?: ArchiveEntry[];
};

type ExpectedSendTimeOptSettings = {
  enabled?: boolean;
  strategy?: SendTimeStrategy;
  quiet_hours_start?: number;
  quiet_hours_end?: number;
  timezone?: string;
  learning_window_days?: number;
  updated_at?: string;
};

type ExpectedSendTimeOptSettingsInput = {
  enabled?: boolean;
  strategy?: SendTimeStrategy;
  quiet_hours_start?: number;
  quiet_hours_end?: number;
  timezone?: string;
  learning_window_days?: number;
};

type ExpectedSendTimeOptHeatmapCell = {
  dow: number;
  hour: number;
  score: number;
  sample_size?: number;
};

type ExpectedSendTimeOptHeatmap = {
  window_days?: number;
  timezone?: string;
  generated_at?: string;
  cells?: SendTimeOptHeatmapCell[];
};

const compatibilityTypeAssertions: [
  Assert<Equal<CampaignPage, ExpectedCampaignPage>>,
  Assert<Equal<CampaignSendInput, ExpectedCampaignSendInput>>,
  Assert<Equal<SendTimeStrategy, "none" | "modal_hour" | "per_recipient">>,
  Assert<Equal<ArchiveEntry, ExpectedArchiveEntry>>,
  Assert<Equal<PublicArchiveIndex, ExpectedPublicArchiveIndex>>,
  Assert<Equal<SendTimeOptSettings, ExpectedSendTimeOptSettings>>,
  Assert<Equal<SendTimeOptSettingsInput, ExpectedSendTimeOptSettingsInput>>,
  Assert<Equal<SendTimeOptHeatmapCell, ExpectedSendTimeOptHeatmapCell>>,
  Assert<Equal<SendTimeOptHeatmap, ExpectedSendTimeOptHeatmap>>,
] = [true, true, true, true, true, true, true, true, true];

describe("generated OpenAPI desktop compatibility schemas", () => {
  it("retains all nine legacy names with their exact generated shapes", () => {
    expect(compatibilityTypeAssertions).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
  });
});
