/**
 * The subscriber profile's WRITE surface, pressed for real.
 *
 * `subscriber-undo-failure.native.test.tsx` reads as if it covers these
 * controls — it presses a thing called "Unsubscribe" and a thing called
 * "Remove tag" — but both are `<Text>` nodes it declares itself, wired
 * straight to the hook. Neither `SubscriberActionRow` nor
 * `SubscriberTagsCard` is imported by that file, so every gate those two
 * components own (read-only, offline, busy, the add-to-list carve-out, the
 * ✕ affordance) was covered in appearance only: the components rendered in
 * snapshot-ish assertions elsewhere and nothing had ever pressed one.
 *
 * So this harness is the SCREEN's composition, not a hook probe: the real
 * `useSubscriberProfileActions` behind the real action row and tags card,
 * with the four sheets the screen opens (`app/(tabs)/subscribers/[id].tsx`)
 * mounted behind the same state the screen holds. The assertions are the
 * consequences — which engine status the PATCH carries, which array a tag
 * removal replaces, which sheet a verb opens, and what the screen does when
 * a gate says no — never that a supplied `jest.fn()` fired.
 *
 * The two rules the profile encodes, both asserted here:
 *   - Unsubscribe writes `blocklisted`, the state desktop and web write. It
 *     used to write `disabled`, so the same person unsubscribed on two
 *     clients ended up in two engine states.
 *   - Resubscribe cannot be a bare `status:"enabled"` PATCH. It opens a
 *     consent review and records evidence, like desktop.
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import React, { useState } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ToastProvider } from "@/components/Toast";
import {
  AddToListModal,
  TagsModal,
} from "@/components/subscriber/SubscriberDetailModals";
import { SubscriberResubscribeReview } from "@/components/subscriber/SubscriberResubscribeReview";
import { SubscriberActionRow } from "@/components/subscriber/sections/SubscriberActionRow";
import { SubscriberTagsCard } from "@/components/subscriber/sections/SubscriberTagsCard";
import { useSubscriberProfileActions } from "@/hooks/useSubscriberProfileActions";
import { subscriberStatusLabel } from "@/lib/subscriberStatus";
import { useTheme } from "@/lib/theme";

const subscriberHooks = require("./mocks/queryHooks.cjs");

const ID = "sub-1";
const EMAIL = "alice@example.com";
const OFFLINE = "You're offline — reconnect to change this contact.";

/** A mutation whose Nth `mutate` call takes a scripted outcome. */
function scriptedMutation(
  script: readonly ("success" | "error")[],
  isPending = false,
) {
  let call = 0;
  const mutate = jest.fn(
    (
      _vars: unknown,
      options?: {
        onSuccess?: (d: unknown) => void;
        onError?: (e: unknown) => void;
      },
    ) => {
      const outcome = script[call] ?? "success";
      call += 1;
      if (outcome === "error") options?.onError?.(new Error("gateway 500"));
      else options?.onSuccess?.(undefined);
    },
  );
  return {
    isPending,
    data: undefined,
    error: null,
    reset: jest.fn(),
    variables: undefined,
    mutateAsync: jest.fn(async () => ({})),
    mutate,
  };
}

function statusMutation(
  script: readonly ("success" | "error")[],
  isPending = false,
) {
  const m = scriptedMutation(script, isPending);
  subscriberHooks.__setHookResultForTests("useSetSubscriberStatus", m);
  return m;
}

function tagsMutation(
  script: readonly ("success" | "error")[],
  isPending = false,
) {
  const m = scriptedMutation(script, isPending);
  subscriberHooks.__setHookResultForTests("useUpdateSubscriberTags", m);
  return m;
}

/**
 * The profile's write surface as `app/(tabs)/subscribers/[id].tsx` composes
 * it: the real action hook, the real action row and tags card, and the sheets
 * the two "open a sheet" verbs actually open.
 */
function Profile({
  canMutate = true,
  canAddToList,
  unavailableReason,
  addToListUnavailableReason,
  status = "enabled",
  tags = ["vip", "loyal"],
}: {
  canMutate?: boolean;
  canAddToList?: boolean;
  unavailableReason?: string;
  addToListUnavailableReason?: string;
  status?: string;
  tags?: readonly string[];
}) {
  const { t } = useTheme();
  const [consentOpen, setConsentOpen] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const actions = useSubscriberProfileActions({
    id: ID,
    email: EMAIL,
    currentStatus: status,
    currentTags: tags,
    canMutate,
  });
  return (
    <>
      <SubscriberActionRow
        canMutate={canMutate}
        {...(canAddToList === undefined ? {} : { canAddToList })}
        {...(unavailableReason ? { unavailableReason } : {})}
        {...(addToListUnavailableReason ? { addToListUnavailableReason } : {})}
        busy={false}
        isSettingStatus={actions.statusPending}
        isSubscribed={subscriberStatusLabel(status) === "Subscribed"}
        onEditTags={() => setTagsOpen(true)}
        onAddToList={() => setListOpen(true)}
        onUnsubscribe={actions.onUnsubscribe}
        onResubscribe={() => setConsentOpen(true)}
      />
      <SubscriberTagsCard
        tags={tags}
        canMutate={canMutate}
        {...(unavailableReason ? { unavailableReason } : {})}
        isUpdatingTags={actions.tagsPending}
        onRemoveTag={actions.onRemoveTag}
      />
      <SubscriberResubscribeReview
        visible={consentOpen}
        id={ID}
        email={EMAIL}
        onClose={() => setConsentOpen(false)}
      />
      <TagsModal
        visible={tagsOpen}
        onClose={() => setTagsOpen(false)}
        subscriberId={ID}
        email={EMAIL}
        currentTags={[...tags]}
        t={t}
      />
      <AddToListModal
        visible={listOpen}
        onClose={() => setListOpen(false)}
        subscriberId={ID}
        email={EMAIL}
        t={t}
      />
    </>
  );
}

async function mount(props: React.ComponentProps<typeof Profile> = {}) {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <ToastProvider>
        <Profile {...props} />
      </ToastProvider>
    </SafeAreaProvider>,
  );
}

/** The action row's button for `label` (not the sheet header of the same name). */
function actionButton(label: string) {
  return screen.getAllByLabelText(label)[0]!;
}

beforeEach(() => {
  subscriberHooks.__resetHookResultsForTests();
});

describe("Unsubscribe", () => {
  it("PATCHes the engine status desktop and web write, and offers it back", async () => {
    const setStatus = statusMutation(["success", "success"]);
    await mount();

    await fireEvent.press(actionButton("Unsubscribe"));

    // `blocklisted`, not `disabled` — the whole reason this module exists.
    expect(setStatus.mutate).toHaveBeenCalledTimes(1);
    expect(setStatus.mutate.mock.calls[0]?.[0]).toEqual({
      id: ID,
      status: "blocklisted",
    });
    expect(screen.getByText("Unsubscribed")).toBeTruthy();

    // The undo restores the status the profile was SHOWING, not a guess.
    await fireEvent.press(screen.getByText("Undo"));
    expect(setStatus.mutate.mock.calls[1]?.[0]).toEqual({
      id: ID,
      status: "enabled",
    });
  });

  it("says so when the server refuses", async () => {
    statusMutation(["error"]);
    await mount();
    await fireEvent.press(actionButton("Unsubscribe"));
    expect(screen.getByText(/Unsubscribed failed/)).toBeTruthy();
    expect(screen.getByText(/gateway 500/)).toBeTruthy();
  });

  it("is inert for a read-only viewer, and the row says why in two places", async () => {
    const setStatus = statusMutation(["success"]);
    await mount({ canMutate: false, unavailableReason: OFFLINE });

    const button = actionButton("Unsubscribe");
    expect(button.props.accessibilityState).toMatchObject({ disabled: true });
    // Spoken to VoiceOver on the control…
    expect(button.props.accessibilityHint).toBe(OFFLINE);
    // …and printed under the row for everyone else. The four actions used to
    // grey out with no explanation at all.
    expect(screen.getByText(OFFLINE)).toBeTruthy();

    await fireEvent.press(button);
    expect(setStatus.mutate).not.toHaveBeenCalled();
  });

  it("renames itself and refuses a second write while one is in flight", async () => {
    const setStatus = statusMutation(["success"], true);
    await mount();
    // The label IS the progress report; there is no separate spinner text.
    expect(screen.queryByLabelText("Unsubscribe")).toBeNull();
    const button = actionButton("Unsubscribing…");
    expect(button.props.accessibilityState).toMatchObject({ busy: true });
    await fireEvent.press(button);
    expect(setStatus.mutate).not.toHaveBeenCalled();
  });
});

describe("Resubscribe — the same slot, the other direction", () => {
  it("replaces Unsubscribe once the contact is already off the list", async () => {
    await mount({ status: "blocklisted" });
    expect(screen.queryByLabelText("Unsubscribe")).toBeNull();
    expect(actionButton("Resubscribe")).toBeTruthy();
  });

  it("opens a consent review instead of writing status:enabled", async () => {
    const setStatus = statusMutation(["success"]);
    await mount({ status: "blocklisted" });

    await fireEvent.press(actionButton("Resubscribe"));

    // Re-enabling MINTS a marketing permission, so the phone records evidence
    // the way desktop does. A bare PATCH from this row would be the
    // compliance regression this path exists to prevent.
    expect(setStatus.mutate).not.toHaveBeenCalled();
    expect(screen.getByText("Review consent to resubscribe")).toBeTruthy();
    expect(
      screen.getByText(
        `This creates a new email-marketing grant for ${EMAIL}. Independent bounce, complaint, and manual suppressions still apply.`,
      ),
    ).toBeTruthy();
    expect(
      screen.getByLabelText("Record consent and resubscribe"),
    ).toBeTruthy();
  });
});

describe("the two verbs that open a sheet", () => {
  it("Edit tags opens the tag sheet for THIS address", async () => {
    await mount();
    await fireEvent.press(actionButton("Edit tags"));
    expect(
      screen.getByText(
        `Tags on ${EMAIL}. Add a new one below, or tap a tag to remove it.`,
      ),
    ).toBeTruthy();
  });

  it("Add to list opens the list picker", async () => {
    await mount();
    await fireEvent.press(actionButton("Add to list"));
    expect(screen.getByLabelText("Add subscriber to list")).toBeTruthy();
  });

  it("keeps Add to list alive offline while every other verb stands down", async () => {
    // AUDIENCE#33: add-to-list is the one audience write that survives a
    // replay, so it is queued rather than refused. The other three need a
    // live connection and must still say so.
    await mount({
      canMutate: false,
      canAddToList: true,
      unavailableReason: OFFLINE,
    });

    expect(
      actionButton("Edit tags").props.accessibilityState,
    ).toMatchObject({ disabled: true });
    expect(
      actionButton("Unsubscribe").props.accessibilityState,
    ).toMatchObject({ disabled: true });

    const add = actionButton("Add to list");
    expect(add.props.accessibilityState).toMatchObject({ disabled: false });
    await fireEvent.press(add);
    expect(screen.getByLabelText("Add subscriber to list")).toBeTruthy();
  });

  it("refuses Edit tags for a read-only viewer", async () => {
    await mount({ canMutate: false, unavailableReason: OFFLINE });
    await fireEvent.press(actionButton("Edit tags"));
    expect(
      screen.queryByText(
        `Tags on ${EMAIL}. Add a new one below, or tap a tag to remove it.`,
      ),
    ).toBeNull();
  });
});

describe("the Tags card removes a tag by REPLACING the set", () => {
  it("sends the surviving tags, receipts the removal, and puts it back", async () => {
    const updateTags = tagsMutation(["success", "success"]);
    await mount();

    // The ✕ is the affordance; the label is what VoiceOver reads.
    expect(screen.getByText("vip  ✕")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Remove tag vip"));

    // `tags` is a FULL-ARRAY REPLACE on PATCH /subscribers/{id}, so a delta
    // here would wipe the rest of the set.
    expect(updateTags.mutate.mock.calls[0]?.[0]).toEqual({
      id: ID,
      tags: ["loyal"],
    });
    expect(screen.getByText('Removed "vip"')).toBeTruthy();

    await fireEvent.press(screen.getByText("Undo"));
    expect(updateTags.mutate.mock.calls[1]?.[0]).toEqual({
      id: ID,
      tags: ["loyal", "vip"],
    });
  });

  it("says so when the removal is refused", async () => {
    tagsMutation(["error"]);
    await mount();
    await fireEvent.press(screen.getByLabelText("Remove tag vip"));
    expect(screen.getByText(/Couldn't remove that tag/)).toBeTruthy();
  });

  it("drops the ✕ and the write for a read-only viewer", async () => {
    const updateTags = tagsMutation(["success"]);
    await mount({ canMutate: false, unavailableReason: OFFLINE });

    // No ✕: the pill stops advertising an action it will refuse.
    expect(screen.getByText("vip")).toBeTruthy();
    expect(screen.queryByText("vip  ✕")).toBeNull();
    const pill = screen.getByLabelText("Remove tag vip");
    expect(pill.props.accessibilityState).toMatchObject({ disabled: true });
    expect(pill.props.accessibilityHint).toBe(OFFLINE);

    await fireEvent.press(pill);
    expect(updateTags.mutate).not.toHaveBeenCalled();
  });

  it("refuses a second removal while one is still in flight", async () => {
    const updateTags = tagsMutation(["success"], true);
    await mount();
    const pill = screen.getByLabelText("Remove tag vip");
    expect(pill.props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(pill);
    expect(updateTags.mutate).not.toHaveBeenCalled();
  });

  it("invites the first tag when the contact has none", async () => {
    await mount({ tags: [] });
    expect(
      screen.getByText('No tags yet. Tap "Edit tags" above to add one.'),
    ).toBeTruthy();
    expect(screen.queryByLabelText(/^Remove tag/)).toBeNull();
  });
});
