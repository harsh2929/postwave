import { createRef, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CampaignDetailEditor,
  type CampaignBodyTab,
  type CampaignEditorDraft,
  type CampaignEditorMode,
} from "../../components/CampaignDetailEditor";

const setState = (): void => undefined;

describe("campaign detail editor boundary", () => {
  it("keeps the complete draft metadata and HTML body form accessible", () => {
    const html = renderEditor();

    expect(html).toContain('id="cam-edit-name"');
    expect(html).toContain('id="cam-edit-subject"');
    expect(html).toContain('id="cam-edit-preview-text"');
    expect(html).toContain('id="cam-edit-audience-mode"');
    expect(html).toContain('id="cam-edit-goal-event"');
    expect(html).toContain('aria-label="Attribution window"');
    expect(html).toContain('id="cam-edit-from-name"');
    expect(html).toContain('id="cam-edit-from"');
    expect(html).toContain('id="cam-edit-body"');
    expect(html).toContain("Dynamic — re-evaluate at send time");
    expect(html).toContain("Static — snapshot now");
    expect(html).toContain("Save changes");
  });

  it("preserves preview mode and validation feedback", () => {
    const html = renderEditor({
      bodyTab: "preview",
      saveErr: "Subject is required.",
    });

    expect(html).toContain("Subject is required.");
    expect(html).toContain('class="tab is-active"');
    expect(html).toContain("Preview");
    expect(html).not.toContain('id="cam-edit-body"');
  });

  it("keeps the editor actions disabled while a save is in flight", () => {
    const html = renderEditor({ saving: true });

    expect(html).toContain("Saving…");
    expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("preserves a role-downgraded draft as read-only with Cancel available", () => {
    const html = renderEditor({ canMutate: false });

    expect(html).toContain("Local draft is read-only");
    expect(html).toContain("Your text is kept");
    expect(html).toMatch(/<input[^>]*id="cam-edit-name"[^>]*disabled=""/);
    expect(html).toMatch(/<textarea[^>]*id="cam-edit-body"[^>]*disabled=""/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save changes<\/button>/);
    expect(html).toMatch(/<button[^>]*>Cancel<\/button>/);
  });

  it("shows semantic nodes and Fact Contract without any legacy body editor", () => {
    const html = renderEditor({
      draft: {
        ...draft(),
        sourceMode: "semantic",
        contentSchemaVersion: 2,
        semanticNodesJSON: '[{"id":"title","type":"heading"}]',
        factContractJSON: '{"schema_version":1}',
      },
    });

    expect(html).toContain("Semantic source · AST v2");
    expect(html).toContain('id="cam-edit-semantic-nodes"');
    expect(html).toContain('id="cam-edit-fact-contract"');
    expect(html).not.toContain('id="cam-edit-body"');
    expect(html).toContain("VITE_ENABLE_CAMPAIGN_CONTENT_AST_V2=1");
  });
});

function renderEditor(
  overrides: {
    bodyTab?: CampaignBodyTab;
    editorMode?: CampaignEditorMode;
    saveErr?: string | null;
    saving?: boolean;
    canMutate?: boolean;
    draft?: CampaignEditorDraft;
  } = {},
): string {
  const node: ReactElement = (
    <CampaignDetailEditor
      id={undefined}
      draft={overrides.draft ?? draft()}
      setDraft={setState}
      savedFromEmail="saved@example.com"
      editorMode={overrides.editorMode ?? "html"}
      setEditorMode={setState}
      blockInstances={[]}
      setBlockInstances={setState}
      setLastComposedMjml={setState}
      setConfirmModeSwitch={setState}
      bodyTab={overrides.bodyTab ?? "edit"}
      setBodyTab={setState}
      editorWrapRef={createRef<HTMLDivElement>()}
      saving={overrides.saving ?? false}
      freezingAudience={false}
      saveErr={overrides.saveErr ?? null}
      canMutate={overrides.canMutate ?? true}
      onCancel={() => undefined}
      onSave={async () => undefined}
      onFreezeAudience={async () => undefined}
    />
  );
  return renderToStaticMarkup(node);
}

function draft(): CampaignEditorDraft {
  return {
    name: "Launch",
    subject: "The launch is here",
    fromName: "Moosewave",
    fromEmail: "hello@example.com",
    body: "<p>Hello</p>",
    previewText: "A short preview",
    goalEvent: "checkout.complete",
    goalWindowHours: 24,
    audienceMode: "dynamic",
  };
}
