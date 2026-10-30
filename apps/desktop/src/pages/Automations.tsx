import type { ReactElement } from "react";

import { OmnichannelSection } from "../components/automations/OmnichannelSection";
import { TriggerDelayCard } from "../components/automations/TriggerDelayCard";
import { ZeroCopyTriggersSection } from "../components/automations/ZeroCopyTriggersSection";
import { PageHeader } from "../components/PageHeader";
import {
  AUTOMATIONS_READINESS_STAGES,
  AUTOMATIONS_RUNTIME_UNAVAILABLE_REASON,
} from "../lib/automation-operational-availability";
import {
  capabilityForSection,
  capabilityReadinessLabel,
} from "../lib/desktop-capabilities";
import { useCanAdmin } from "../lib/store";

import "../styles-automations.css";

export function Automations(): ReactElement {
  const canAdmin = useCanAdmin();
  const capability = capabilityForSection("automations");

  return (
    <div className="page page-with-pad automations-page">
      <PageHeader
        eyebrow="Automations"
        title="Design now. Run after qualification."
        subtitle="Define and inspect warehouse-trigger, timing, and omnichannel drafts without mistaking stored configuration for live execution or delivery."
      />

      <section
        className="automations-readiness"
        aria-labelledby="automations-readiness-title"
      >
        <div className="automations-readiness__intro">
          <div>
            <span className="automations-readiness__badge">
              {capabilityReadinessLabel(capability.readiness) ??
                "Limited readiness"}
            </span>
            <h2 id="automations-readiness-title">Runtime readiness</h2>
            <p>
              {capability.limitation ?? AUTOMATIONS_RUNTIME_UNAVAILABLE_REASON}
            </p>
          </div>
          <p className="automations-readiness__boundary">
            <strong>Current boundary</strong>
            Draft definition and inspection are available. Activation, polling,
            audience materialization, dispatch, and delivery proof are
            unavailable in this build.
          </p>
        </div>

        <ol
          className="automations-readiness__stages"
          aria-label="Readiness stages"
        >
          {AUTOMATIONS_READINESS_STAGES.map((stage, index) => (
            <li key={stage.id} data-tone={stage.tone}>
              <span className="automations-readiness__step" aria-hidden="true">
                {String(index + 1).padStart(2, "0")}
              </span>
              <div>
                <strong>{stage.label}</strong>
                <span>{stage.detail}</span>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <nav className="automations-jump-nav" aria-label="Automation tools">
        <a href="#warehouse-trigger-drafts">Warehouse trigger drafts</a>
        <a href="#manual-timing-overrides">Manual timing overrides</a>
        <a href="#omnichannel-definitions">Campaign definitions</a>
      </nav>

      <div className="automations-sections">
        <ZeroCopyTriggersSection canAdmin={canAdmin} />
        <TriggerDelayCard canAdmin={canAdmin} />
        <OmnichannelSection canAdmin={canAdmin} />
      </div>
    </div>
  );
}
