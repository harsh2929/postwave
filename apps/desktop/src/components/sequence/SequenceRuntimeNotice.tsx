import type { ReactElement } from "react";

import {
  SEQUENCE_RUNTIME_UNAVAILABLE_REASON,
  type SequenceStatusPresentation,
} from "../../lib/sequence-operational-availability";

export function SequenceRuntimeNotice({
  status,
}: {
  status: SequenceStatusPresentation;
}): ReactElement {
  return (
    <section
      className="seq-runtime-boundary"
      aria-labelledby="sequence-runtime-boundary-title"
    >
      <div className="seq-runtime-boundary-copy">
        <div className="seq-runtime-boundary-eyebrow">Execution boundary</div>
        <h2 id="sequence-runtime-boundary-title">
          Design the journey here. Keep live delivery off.
        </h2>
        <p>{SEQUENCE_RUNTIME_UNAVAILABLE_REASON}</p>
        <div className="seq-runtime-current-state">
          <span className={`seq-runtime-state-dot is-${status.tone}`} />
          <span>
            Stored state: <strong>{status.label}</strong>
          </span>
          <span className="muted">{status.detail}</span>
        </div>
      </div>
      <ol
        className="seq-runtime-capability-map"
        aria-label="Sequence readiness"
      >
        <li className="is-ready">
          <span aria-hidden="true">1</span>
          <div>
            <strong>Draft &amp; review</strong>
            <small>Available now</small>
          </div>
        </li>
        <li className="is-blocked">
          <span aria-hidden="true">2</span>
          <div>
            <strong>Entry &amp; enrollment</strong>
            <small>Runtime required</small>
          </div>
        </li>
        <li className="is-blocked">
          <span aria-hidden="true">3</span>
          <div>
            <strong>Delivery &amp; analytics</strong>
            <small>Runtime required</small>
          </div>
        </li>
      </ol>
    </section>
  );
}
