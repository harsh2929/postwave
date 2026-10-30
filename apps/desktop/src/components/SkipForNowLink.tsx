/**
 * SkipForNowLink — small ghost link used inside onboarding checklist
 * step bodies. Lower-case copy by convention; never ends in a period.
 */

import type { ReactElement } from "react";

interface Props {
  onClick: () => void;
  label?: string;
}

export function SkipForNowLink({ onClick, label = "skip for now" }: Props): ReactElement {
  return (
    <button type="button" className="checklist-step-skip" onClick={onClick}>
      {label}
    </button>
  );
}
