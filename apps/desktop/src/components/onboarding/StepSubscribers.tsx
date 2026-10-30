/**
 * Onboarding · Step 2 — Import or add subscribers.
 *
 * Three large card buttons: import CSV (hands off to Subscribers page),
 * add manually (also Subscribers page), or seed sample data via
 * `seedSampleDataStrict()`. The endpoint is live; setup errors are shown
 * plainly so packaged desktop builds do not hide a broken onboarding path.
 *
 * Import/manual cards use the canonical desktop route overlay. The route is
 * reload/history safe and identity-scoped by the router; Subscribers consumes
 * and clears the overlay after opening the matching modal.
 */

import { type ReactElement, useState } from "react";

import { seedSampleDataStrict } from "../../lib/api-client";
import { navigateDesktopRoute } from "../../lib/desktop-router";
import { toast } from "../Toast";

interface Props {
  onAdvance: () => void;
  onSkip: () => void;
  onDismiss: () => void;
}

export function StepSubscribers({
  onAdvance,
  onSkip,
  onDismiss,
}: Props): ReactElement {
  const [seeding, setSeeding] = useState(false);
  const [seedNote, setSeedNote] = useState<string | null>(null);

  const goSubscribers = (modal?: "import" | "create"): void => {
    navigateDesktopRoute({
      section: "subscribers",
      ...(modal ? { overlay: { name: modal } } : {}),
    });
    onSkip();
  };

  const handleSeed = async (): Promise<void> => {
    setSeeding(true);
    setSeedNote(null);
    const res = await seedSampleDataStrict();
    setSeeding(false);
    if (res.error) {
      setSeedNote(res.error.message);
      return;
    }
    const r = res.data;
    const parts: string[] = [];
    if (r.counts.subscribers) parts.push(`${r.counts.subscribers} subscribers`);
    if (r.counts.lists) parts.push(`${r.counts.lists} lists`);
    if (r.counts.campaigns) parts.push(`${r.counts.campaigns} campaigns`);
    if (r.counts.sequences) parts.push(`${r.counts.sequences} sequences`);
    toast.success(parts.length > 0 ? `Loaded sample: ${parts.join(", ")}` : "Sample data loaded");
    onAdvance();
  };

  return (
    <div className="onb2-step">
      <div className="onb2-step-illustration" aria-hidden="true">
        <span className="onb2-step-num">2</span>
      </div>
      <h3 className="onb2-step-title">Import or add subscribers</h3>
      <p className="onb2-step-desc">
        Pick how you&apos;d like to populate your audience.
      </p>

      <div className="onb2-card-grid">
        <button
          type="button"
          className="onb2-card"
          onClick={() => goSubscribers("import")}
          aria-label="Import a CSV file in the Subscribers page"
        >
          <div className="onb2-card-glyph" aria-hidden="true">↥</div>
          <div className="onb2-card-title">Import CSV</div>
          <div className="onb2-card-desc">
            Bring an export from Mailchimp, ConvertKit, or anywhere else.
          </div>
        </button>

        <button
          type="button"
          className="onb2-card"
          onClick={() => goSubscribers("create")}
          aria-label="Add a subscriber manually"
        >
          <div className="onb2-card-glyph" aria-hidden="true">+</div>
          <div className="onb2-card-title">Add manually</div>
          <div className="onb2-card-desc">
            Type one in by hand — useful for testing your first send.
          </div>
        </button>

        <button
          type="button"
          className="onb2-card"
          onClick={() => void handleSeed()}
          disabled={seeding}
          aria-label="Load demo sample data"
        >
          <div className="onb2-card-glyph" aria-hidden="true">★</div>
          <div className="onb2-card-title">
            {seeding ? "Loading…" : "Load sample data"}
          </div>
          <div className="onb2-card-desc">
            Skip the chores — populate a list and a draft to explore the app.
          </div>
        </button>
      </div>

      {seedNote ? <div className="onb2-note muted">{seedNote}</div> : null}

      <div className="onb2-step-actions">
        <button type="button" className="btn-link" onClick={onSkip}>
          Skip for now
        </button>
      </div>
      <button type="button" className="btn-link onb2-dismiss-link" onClick={onDismiss}>
        Don&apos;t show this again
      </button>
    </div>
  );
}
