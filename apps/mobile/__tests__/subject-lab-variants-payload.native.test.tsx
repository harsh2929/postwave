/**
 * What the Subject Lab generator actually PUTS ON THE WIRE.
 *
 * The screen test next door pins who may see this panel and when the button is
 * live. Neither of those can see the request body, and the body is where this
 * panel got it wrong: it sent `voiceProfileId: "active"`.
 *
 * "active" is a real contract — but only on the chat `context_refs` path, where
 * services/voice `renderVoiceProfileRef(ctx, h, tenant)` resolves the profile
 * from the TENANT and never reads the id. POST /api/v1/subject-lab/variants is
 * a different path with the opposite behaviour: subject_lab.go hands the field
 * to `ComposeVariantsInput.ProfileID`, and aicompose's `profileBindingExtra`
 * (aicompose.go:441-447) renders a non-empty id VERBATIM as the context line
 * "Bound brand voice profile: <id>". So the sentinel wrote a profile id that
 * does not exist into the prompt and into the auditable context_text, directly
 * beside the "Brand voice profile: <real id>" line `loadBrandVoice` emits from
 * the tenant — two lines disagreeing about one profile, and zero extra
 * conditioning, because `ContextText` loads that voice whether or not the
 * client sends an id.
 *
 * The fix is that the field is ABSENT, so the assertion is on the exact key
 * set rather than on one key's value: sending "" or `null` or any other
 * placeholder is the same mistake wearing a different hat, and an exact key
 * set is the only shape of assertion that catches all of them.
 *
 * The mutation hook is mocked — not the transport — because the payload
 * handed to `mutate` is the panel's whole decision here; api/subjectLabVariants
 * only forwards it (and already omits an absent id).
 */
import { describe, expect, it, jest, beforeEach } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { SubjectLabVariantsPanel } from "@/components/voice/SubjectLabVariantsPanel";

/**
 * Captured at CALL time, not at factory time — the factory below runs while
 * the panel module is being required, before this array exists.
 */
const mockGenerateCalls: Record<string, unknown>[] = [];

jest.mock("@/hooks/useSubjectLabVariants", () => ({
  useGenerateSubjectVariants: () => ({
    data: undefined,
    error: null,
    isError: false,
    isPending: false,
    isSuccess: false,
    mutate: (input: Record<string, unknown>) => {
      mockGenerateCalls.push(input);
    },
    reset: () => undefined,
  }),
}));

const SEED_FIELD = "Subject line to generate variants from";
/** Long enough to clear the server's `seed_too_short` floor (10 chars). */
const SEED = "Your April report is ready";

function renderPanel() {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <SubjectLabVariantsPanel offline={false} onScoreThese={() => undefined} />
    </SafeAreaProvider>,
  );
}

beforeEach(() => {
  mockGenerateCalls.length = 0;
});

describe("Subject Lab variants payload", () => {
  it("sends the seed, the axis and a count — and no voice profile id at all", async () => {
    await renderPanel();
    await fireEvent.changeText(screen.getByLabelText(SEED_FIELD), SEED);
    await fireEvent.press(screen.getByLabelText("Generate"));

    expect(mockGenerateCalls).toHaveLength(1);
    const sent = mockGenerateCalls[0]!;
    // EXACT key set. `/variants` interpolates whatever id it is given, so the
    // only correct thing to send when there is no profile picker is nothing.
    expect(Object.keys(sent).sort()).toEqual(["axis", "count", "seedSubject"]);
    expect("voiceProfileId" in sent).toBe(false);
    expect(sent.seedSubject).toBe(SEED);
    expect(sent.axis).toBe("length");
  });

  it("carries the chosen axis rather than a fixed one", async () => {
    // The axis is the whole reason this route exists rather than a second copy
    // of the campaign sheet's paraphraser, and it is the one field the person
    // sets by hand — so it has to survive the same press, unchanged.
    await renderPanel();
    await fireEvent.changeText(screen.getByLabelText(SEED_FIELD), SEED);
    await fireEvent.press(screen.getByLabelText("Question"));
    await fireEvent.press(screen.getByLabelText("Generate"));

    expect(mockGenerateCalls).toHaveLength(1);
    expect(mockGenerateCalls[0]!.axis).toBe("question");
    expect(Object.keys(mockGenerateCalls[0]!).sort()).toEqual([
      "axis",
      "count",
      "seedSubject",
    ]);
  });
});
