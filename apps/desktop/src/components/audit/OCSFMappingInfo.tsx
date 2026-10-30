/**
 * OCSFMappingInfo — explanatory panel rendered next to the per-sink
 * `output_format` selector in AuditSinks.
 *
 * Three roles:
 *   1. Show analyst-facing why-it-matters copy (procurement gate;
 *      shadow-banning by detection-engineering teams).
 *   2. Surface the OCSF classes Moosewave emits with a tiny example
 *      JSON envelope so the operator can eyeball "yes that is what my
 *      SIEM expects" before flipping the toggle.
 *   3. Reference the full field mapping doc + Sigma rule pack (plain
 *      code references — repo-relative links are dead in the Tauri
 *      webview).
 */

import type { ReactElement } from "react";

import type { AuditSinkOutputFormat } from "../../lib/api-client";

const SAMPLE_OCSF = `{
  "class_uid": 3004,
  "class_name": "Entity Management",
  "category_uid": 3,
  "activity_id": 4,
  "type_uid": 300404,
  "severity_id": 4, "severity": "High",
  "status_id": 1, "status": "Success",
  "time": 1747044000000,
  "entity_type": "subscriber",
  "entity_uid": "s-1",
  "operation": "Delete",
  "actor": { "user": { "uid": "u-alice", "type_id": 2 } },
  "metadata": { "version": "1.8.0", "product": { "name": "Moosewave" } }
}`;

export interface OCSFMappingInfoProps {
  /** Currently selected output format — drives which preview shows. */
  format: AuditSinkOutputFormat;
}

export function OCSFMappingInfo({ format }: OCSFMappingInfoProps): ReactElement {
  if (format !== "ocsf_1_8") {
    return (
      <div
        role="note"
        style={{
          marginTop: 8,
          padding: 10,
          borderRadius: 6,
          background: "var(--pw-bg-elev-2)",
          fontSize: 12,
          lineHeight: 1.45,
        }}
      >
        <strong>postwave_native</strong> — historic envelope. Backwards
        compatible; supported indefinitely. Use this for receivers that
        already parse the Moosewave audit shape.
      </div>
    );
  }
  return (
    <div
      role="note"
      style={{
        marginTop: 8,
        padding: 10,
        borderRadius: 6,
        background: "var(--pw-bg-elev-2)",
        fontSize: 12,
        lineHeight: 1.45,
      }}
    >
      <p style={{ margin: "0 0 6px 0" }}>
        <strong>OCSF 1.8</strong> — Linux Foundation schema consumed
        natively by Splunk, Datadog Cloud SIEM, Microsoft Sentinel Data
        Lake, Google SecOps, and AWS Security Lake.
      </p>
      {/* Repo-relative doc paths are rendered as plain code references,
          not links — a relative href resolves against tauri://localhost
          in the desktop webview and is dead on arrival. */}
      <p style={{ margin: "0 0 8px 0" }}>
        Moosewave routes actions to OCSF classes 3001 (Account Change),
        3002 (Authentication), 3004 (Entity Management), and 6003 (API
        Activity). Pair this format with the bundled Sigma rule pack
        (<code>docs/sigma/postwave/rules/</code> in the Moosewave repo)
        for ready-to-use detections.
      </p>
      <details>
        <summary style={{ cursor: "pointer" }}>Sample event</summary>
        <pre
          style={{
            margin: "6px 0 0 0",
            padding: 8,
            background: "var(--pw-bg-elev)",
            borderRadius: 4,
            overflowX: "auto",
            fontSize: 11,
          }}
        >
          {SAMPLE_OCSF}
        </pre>
      </details>
      <p style={{ margin: "8px 0 0 0" }}>
        Full mapping: <code>docs/audit/ocsf-mapping.md</code> in the
        Moosewave repo.
      </p>
    </div>
  );
}
