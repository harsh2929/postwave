// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// A/B test for the email open in the sequence editor (desktop parity
// automation-68). The split is stored on the email step itself
// (`steps[].email.variants`) and saved with the draft through the ordinary
// version-protected PATCH /api/v1/voice/sequences/{id} — the page performs the
// save; this dialog only produces a validated list (or `undefined` to remove
// the test).

import { useState, type RefObject } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  StepAbTestPanel,
  abTestStateFrom,
  abTestVariants,
  type AbTestBase,
  type AbTestState,
} from "@/components/sequence/StepAbTestPanel";
import type { SequenceEmailVariant } from "@/lib/voice-types";

export function SequenceAbVariantsDialog({
  emailPosition,
  email,
  variants,
  canEdit,
  lockedReason,
  onSave,
  onClose,
  returnFocus,
}: {
  emailPosition: number;
  /** The email's current content — arm A of a freshly enabled test. */
  email: AbTestBase;
  /** The split currently stored on this email step, if any. */
  variants: SequenceEmailVariant[] | undefined;
  canEdit: boolean;
  lockedReason?: string;
  /** Store the split (`undefined` removes it) and save the draft. */
  onSave: (variants: SequenceEmailVariant[] | undefined) => void;
  onClose: () => void;
  returnFocus: RefObject<HTMLButtonElement | null>;
}) {
  const [ab, setAb] = useState<AbTestState>(() => abTestStateFrom(variants));
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    if (!canEdit) {
      setError(lockedReason ?? "Editing is unavailable.");
      return;
    }
    const result = abTestVariants(ab);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    onSave(result.variants);
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-w-3xl"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          // This controlled dialog does not use DialogTrigger because its
          // launch button lives in the editor toolbar. Restore focus after
          // Radix removes the focus scope so the toolbar is not blurred again
          // during its close animation.
          requestAnimationFrame(() => returnFocus.current?.focus());
        }}
      >
        <DialogHeader>
          <DialogTitle>A/B test for email #{emailPosition}</DialogTitle>
          <DialogDescription>
            Split this email into 2–4 variants. Saving stores the split on the
            email step and saves the draft.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto pr-1">
          <StepAbTestPanel
            value={ab}
            base={email}
            disabled={!canEdit}
            error={error}
            onChange={(next) => {
              setAb(next);
              setError(null);
            }}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={save}
            disabled={!canEdit}
            title={canEdit ? undefined : lockedReason}
          >
            Save A/B test
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
