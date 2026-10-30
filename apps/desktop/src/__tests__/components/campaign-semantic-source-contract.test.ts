import { describe, expect, it } from "vitest";

import type { CampaignEditorDraft } from "../../components/CampaignDetailEditor";
import {
  draftFromDetail,
  parseSemanticCampaignDraft,
} from "../../components/campaigns/useCampaignEditorController";

const baseDraft: CampaignEditorDraft = {
  name: "Launch",
  subject: "Subject",
  fromName: "Moosewave",
  fromEmail: "sender@example.test",
  body: "<p>stale projection</p>",
  previewText: "Preview",
  goalEvent: "",
  goalWindowHours: 0,
  audienceMode: "dynamic",
  sourceMode: "semantic",
  contentSchemaVersion: 2,
  semanticNodesJSON: '[{"id":"cta","opaque":{"kept":true}}]',
  factContractJSON: '{"schema_version":1,"primary_action":{"action_id":"go"}}',
};

describe("desktop semantic campaign source contract", () => {
  it("preserves server semantic nodes and Fact Contract in the local draft", () => {
    const draft = draftFromDetail(
      {
        id: "campaign-1",
        name: "Launch",
        subject: "Subject",
        source_mode: "semantic",
        content_schema_version: 2,
        content_blocks: [
          { id: "title", type: "heading", nested: { kept: true } },
        ],
        fact_contract: { schema_version: 1, audience: "members" },
      },
      "sender@example.test",
    );

    expect(draft.sourceMode).toBe("semantic");
    expect(JSON.parse(draft.semanticNodesJSON ?? "null")).toEqual([
      { id: "title", type: "heading", nested: { kept: true } },
    ]);
    expect(JSON.parse(draft.factContractJSON ?? "null")).toEqual({
      schema_version: 1,
      audience: "members",
    });
  });

  it("parses the two semantic authorities together without projecting HTML", () => {
    expect(parseSemanticCampaignDraft(baseDraft)).toEqual({
      content_blocks: [{ id: "cta", opaque: { kept: true } }],
      fact_contract: {
        schema_version: 1,
        primary_action: { action_id: "go" },
      },
    });
  });

  it.each([
    ["nodes object", { semanticNodesJSON: "{}" }],
    ["nodes empty", { semanticNodesJSON: "[]" }],
    ["fact array", { factContractJSON: "[]" }],
    ["invalid JSON", { semanticNodesJSON: "[" }],
  ])("rejects %s before dispatch", (_name, patch) => {
    expect(() =>
      parseSemanticCampaignDraft({ ...baseDraft, ...patch }),
    ).toThrow();
  });
});
