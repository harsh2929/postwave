/**
 * Both places a phone can ask the model for subject lines have to ask in the
 * WORKSPACE's voice.
 *
 * This is a seam that fails silently in the worst way: with no voice profile
 * ref the request is still valid, still streams, and still returns three
 * plausible subject lines — they are just the ones any workspace on the
 * platform would get. Nothing errors, nothing is logged, and the only symptom
 * is that suggestions written on a laptop sound like the brand and the ones
 * written on a phone do not.
 *
 * `ACTIVE_VOICE_PROFILE` is asserted as the literal the server actually
 * resolves (services/voice/.../chat.go renderVoiceProfileRef looks the profile
 * up from the request's tenant and ignores the id) — a different sentinel
 * would type-check and quietly do nothing.
 *
 * MOVED FROM VITEST (was src/components/campaigns/SubjectSuggestionsVoice.test.tsx,
 * which never executed under any runner). Both sheets reach
 * useCampaignIdentitySave / useCampaignMutations → store/auth →
 * expo-secure-store → expo-modules-core, which throws `__DEV__ is not defined`
 * at import time under node vitest, so the file failed to load and its three
 * assertions had never once run.
 *
 * The move also STRENGTHENED them. The old file stubbed the suggestion strip
 * to a host element and asserted the `voiceProfileId` PROP it was handed —
 * true of a strip that ignores the prop. Here the strip renders for real and
 * the assertion is on the request it builds: what actually reaches
 * POST /api/v1/voice/generate. `@/api/aiGenerate` is stubbed because it is the
 * transport, and a test may not make a network call; everything between the
 * sheet and it runs.
 *
 * Sheets are imported RELATIVELY, like campaign-subject-ab-axis: the config
 * maps `@/components/campaigns/*` to a null stub to keep route composition
 * cheap, and a stubbed sheet would make every assertion vacuous.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";

const mockStreamAIGenerate = jest.fn(() => ({ abort: jest.fn() }));

/** The transport boundary, and the only thing stubbed below the sheets. */
jest.mock("@/api/aiGenerate", () => ({
  streamAIGenerate: mockStreamAIGenerate,
}));

// One factory for the whole null-stubbed `@/components/campaigns/*` family —
// see the file for why two jest.mock() calls here would cancel each other out.
jest.mock("@/components/campaigns/CampaignFieldInput", () =>
  require("./mocks/campaignSheetLeaves.cjs"),
);

const { CampaignSubjectModal } =
  require("../src/components/campaigns/CampaignSubjectModal") as typeof import("../src/components/campaigns/CampaignSubjectModal");
const { CampaignCreateModal } =
  require("../src/components/campaigns/CampaignCreateModal") as typeof import("../src/components/campaigns/CampaignCreateModal");
const { SubjectLineSuggestions } =
  require("../src/components/SubjectLineSuggestions") as typeof import("../src/components/SubjectLineSuggestions");

/**
 * The REAL sentinel, not a fixture: a local copy would make every assertion
 * below true by construction. It lives in its own dependency-free module
 * precisely so anything may import it — see src/lib/aiVoiceProfile.ts.
 */
const { ACTIVE_VOICE_PROFILE } =
  require("../src/lib/aiVoiceProfile") as typeof import("../src/lib/aiVoiceProfile");

const CAMPAIGN = {
  id: "cmp_1",
  name: "August newsletter",
  status: "draft",
  subject: "Saved subject",
  preview_text: "Saved preview",
  from_name: "Ada",
  reply_to: "ada@example.com",
  created_at: "2026-08-01T10:00:00Z",
  updated_at: "2026-08-04T10:00:00Z",
} as Parameters<typeof CampaignSubjectModal>[0]["campaign"];

/** A brief, not a keystroke: the strip only mounts at ≥ 10 characters. */
const BRIEF = "A subject long enough to brief on";

interface GenerateRequest {
  prompt: string;
  kind: string;
  contextRefs: { type: string; id: string }[];
}

function generateRequests(): GenerateRequest[] {
  return mockStreamAIGenerate.mock.calls.map(
    (call) => (call as unknown[])[0] as GenerateRequest,
  );
}

/** The strip debounces 500ms against the subject before it asks. */
async function letTheStripAsk(): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(600);
  });
}

async function typeSubject(value: string): Promise<void> {
  await fireEvent.changeText(screen.getByLabelText("Subject line"), value);
}

beforeEach(() => {
  jest.useFakeTimers();
  mockStreamAIGenerate.mockClear();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("the brand voice reaches both generators", () => {
  it("is sent by the campaign subject sheet", async () => {
    await render(
      <CampaignSubjectModal
        visible
        onClose={() => undefined}
        campaign={CAMPAIGN}
      />,
    );
    await typeSubject(BRIEF);
    await letTheStripAsk();

    expect(generateRequests()).toEqual([
      expect.objectContaining({
        kind: "subject_line",
        contextRefs: [{ type: "voice_profile", id: ACTIVE_VOICE_PROFILE }],
      }),
    ]);
  });

  it("is sent by the create sheet", async () => {
    await render(
      <CampaignCreateModal visible canCreate onClose={() => undefined} />,
    );
    await typeSubject(BRIEF);
    await letTheStripAsk();

    expect(generateRequests()).toEqual([
      expect.objectContaining({
        kind: "subject_line",
        contextRefs: [{ type: "voice_profile", id: ACTIVE_VOICE_PROFILE }],
      }),
    ]);
  });

  it("is the sentinel the voice service resolves, not a row id", () => {
    expect(ACTIVE_VOICE_PROFILE).toBe("active");
  });

  /**
   * The control that makes the two assertions above falsifiable. This is the
   * exact regression they exist to catch, driven deliberately: the same strip,
   * the same brief, the prop simply absent. The request is still well-formed
   * and still streams — it just carries nobody's voice.
   */
  it("is the ONLY thing that puts a voice on the request", async () => {
    await render(
      <SubjectLineSuggestions
        currentSubject={BRIEF}
        onPickVariant={() => undefined}
      />,
    );
    await letTheStripAsk();

    expect(generateRequests()).toEqual([
      expect.objectContaining({ kind: "subject_line", contextRefs: [] }),
    ]);
  });

  it("asks nothing at all until the subject is long enough to brief on", async () => {
    await render(
      <CampaignSubjectModal
        visible
        onClose={() => undefined}
        campaign={CAMPAIGN}
      />,
    );
    await typeSubject("Too short");
    await letTheStripAsk();

    expect(mockStreamAIGenerate).not.toHaveBeenCalled();
    expect(
      screen.getByText("Type at least 10 characters to see AI variants."),
    ).toBeTruthy();
  });
});
