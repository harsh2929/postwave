/**
 * Onboarding · Step 4 — Completion screen.
 *
 * Celebratory but restrained — the spec calls out "no emoji". A large
 * "All set." headline, a primary "Start exploring" close button, and
 * three follow-up suggestions wired to the canonical desktop router. The
 * parent state machine marks completion only after an explicit close path.
 */

import { type ReactElement } from "react";

import {
  navigateDesktopRoute,
  type DesktopRoute,
} from "../../lib/desktop-router";

interface Props {
  /** Close + persist dismissal — parent owns the localStorage write. */
  onClose: () => void;
}

interface FollowUp {
  route: DesktopRoute;
  title: string;
  body: string;
}

const FOLLOW_UPS: FollowUp[] = [
  {
    route: { section: "settings", settingsAnchor: "slack" },
    title: "Connect Slack for approvals",
    body: "Route human-in-the-loop sign-off to a channel.",
  },
  {
    route: { section: "settings", settingsAnchor: "security" },
    title: "Protect your account",
    body: "Set up two-step verification before inviting collaborators.",
  },
  {
    route: { section: "sequences" },
    title: "Set up sequences",
    body: "Drip campaigns triggered by tags, behaviour, or time.",
  },
];

export function StepDone({ onClose }: Props): ReactElement {
  const goAndClose = (route: DesktopRoute): void => {
    navigateDesktopRoute(route);
    onClose();
  };

  return (
    <div className="onb2-step onb2-step-done">
      <div className="onb2-done-headline">All set.</div>
      <p className="onb2-step-desc">
        You&apos;re ready to send. A few things you might want next:
      </p>

      <ul className="onb2-followups">
        {FOLLOW_UPS.map((f) => (
          <li key={f.route.section + f.title}>
            <button
              type="button"
              className="onb2-followup"
              onClick={() => goAndClose(f.route)}
            >
              <span className="onb2-followup-title">{f.title}</span>
              <span className="onb2-followup-body">{f.body}</span>
            </button>
          </li>
        ))}
      </ul>

      <div className="onb2-step-actions">
        <button type="button" className="btn btn-primary" onClick={onClose}>
          Start exploring
        </button>
      </div>
    </div>
  );
}
