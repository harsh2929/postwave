/**
 * AuditSinkForm — extracted output-format radio group + OCSF preview.
 *
 * Intended use: any future screen that needs to surface the per-sink
 * output_format choice without recreating the full AuditSinks page
 * (e.g. onboarding wizards, tenant-admin bulk-config screens). The
 * AuditSinks page itself inlines an equivalent selector so it stays
 * a single-file rendering surface, but the logic is duplicated only
 * in trivial radio-group shape — the OCSF copy lives in
 * OCSFMappingInfo.
 */

import type { ReactElement } from "react";

import type { AuditSinkOutputFormat } from "../../lib/api-client";

import { OCSFMappingInfo } from "./OCSFMappingInfo";

export interface AuditSinkFormProps {
  value: AuditSinkOutputFormat;
  onChange: (next: AuditSinkOutputFormat) => void;
  /** Stable prefix used to namespace input ids (required when multiple
   *  selectors render in the same DOM, e.g. modal + slideover). */
  idPrefix: string;
  /** Hide the OCSF info panel — useful when the caller already renders
   *  its own explanatory copy. */
  hideInfo?: boolean;
}

export function AuditSinkOutputFormatField({
  value,
  onChange,
  idPrefix,
  hideInfo = false,
}: AuditSinkFormProps): ReactElement {
  return (
    <div>
      <div
        role="radiogroup"
        aria-label="Sink output format"
        style={{ display: "flex", gap: 16 }}
      >
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="radio"
            id={`${idPrefix}-fmt-native`}
            name={`${idPrefix}-output-format`}
            value="postwave_native"
            checked={value === "postwave_native"}
            onChange={() => onChange("postwave_native")}
          />
          <span>Moosewave native</span>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="radio"
            id={`${idPrefix}-fmt-ocsf`}
            name={`${idPrefix}-output-format`}
            value="ocsf_1_8"
            checked={value === "ocsf_1_8"}
            onChange={() => onChange("ocsf_1_8")}
          />
          <span>OCSF 1.8</span>
        </label>
      </div>
      {hideInfo ? null : <OCSFMappingInfo format={value} />}
    </div>
  );
}
