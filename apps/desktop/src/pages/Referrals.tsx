/**
 * Authenticated referral snapshot and historical signal inspection.
 * Activation, subscriber-link, payout, and website-install paths stay
 * centrally fail-closed until their release evidence is complete.
 */

import { type ReactElement, useEffect, useState } from "react";

import { ReferralsPageContent } from "../components/referrals/ReferralsPageContent";
import { REFERRAL_PROGRAM_MUTATIONS_AVAILABLE } from "../lib/referral-operational-availability";
import { useCanAdmin } from "../lib/store";
import { ProgramEditor } from "./referrals/ProgramEditor";
import { useReferralProgramController } from "./referrals/useReferralProgramController";
import "../styles-referrals.css";

export function Referrals(): ReactElement {
  const canAdmin = useCanAdmin();
  const canMutate = canAdmin && REFERRAL_PROGRAM_MUTATIONS_AVAILABLE;
  const controller = useReferralProgramController(canMutate);
  const { load, milestones, state } = controller;
  const canManageProgram = canMutate && !state.loading && state.error === null;
  const [editorFocusIndex, setEditorFocusIndex] = useState<number | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);

  useEffect(() => {
    if (canMutate) return;
    setEditorFocusIndex(null);
    setEditorOpen(false);
  }, [canMutate]);

  const openEditor = (index?: number): void => {
    if (!canManageProgram) return;
    setEditorFocusIndex(index ?? null);
    setEditorOpen(true);
  };

  const closeEditor = (): void => {
    setEditorOpen(false);
    setEditorFocusIndex(null);
  };

  return (
    <>
      <ReferralsPageContent
        canAdmin={canAdmin}
        canManageProgram={canManageProgram}
        milestones={milestones}
        state={state}
        onCreate={openEditor}
        onEdit={openEditor}
        onRefresh={() => void load()}
      />

      <ProgramEditor
        canMutate={canMutate}
        open={editorOpen}
        program={state.program}
        focusRow={editorFocusIndex}
        onClose={closeEditor}
        onSaved={() => {
          closeEditor();
          void load();
        }}
      />
    </>
  );
}
