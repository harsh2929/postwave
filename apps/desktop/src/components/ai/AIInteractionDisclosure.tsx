// SPDX-License-Identifier: AGPL-3.0-only
//
// EU AI Act Article 50(1) interaction disclosure — the canonical "you are
// talking to an AI" notice, rendered on every interactive AI/agent surface.
//
// The text is the single shared source of truth (@postwave/ai-disclosure),
// mirrored by the Go gateway and byte-for-byte drift-guarded, so web, desktop,
// and mobile all render the identical legally-mandated notice. Art. 50 is in
// force 2026-08-02.

import { type ReactElement } from "react";

import {
  AI_DISCLOSURE_LABEL,
  AI_DISCLOSURE_TEXT,
} from "@postwave/ai-disclosure";
import "../../styles-ai-interaction-disclosure.css";

export function AIInteractionDisclosure({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}): ReactElement {
  return (
    <p
      role="note"
      aria-label={AI_DISCLOSURE_LABEL}
      data-testid="ai-interaction-disclosure"
      className={`ai-interaction-disclosure${className ? ` ${className}` : ""}`}
      style={style}
    >
      {AI_DISCLOSURE_TEXT}
    </p>
  );
}
