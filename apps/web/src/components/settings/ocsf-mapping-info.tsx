// SPDX-License-Identifier: AGPL-3.0-only

//
// Explanatory panel rendered beside an audit sink's output-format selector
// (desktop parity: components/audit/OCSFMappingInfo.tsx). It states which
// OCSF 1.8 classes Moosewave emits (apps/api/internal/auditsink/ocsf/mapper.go:
// 3001, 3002, 3004, 6003) and discloses one hard-coded sample envelope so an
// operator can eyeball "yes, that is what my SIEM expects" before switching.
// Repository documents are named as code, not linked: they are not served by
// this app.

import type { OutputFormat } from "@/lib/audit-sinks-api";

export const OCSF_SAMPLE_EVENT = `{
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

export function OcsfMappingInfo({ format }: { format: OutputFormat }) {
  if (format !== "ocsf_1_8") {
    return (
      <div
        role="note"
        className="rounded-md border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground"
      >
        <strong className="text-foreground">postwave_native</strong> — the
        historic envelope. Backwards compatible and supported indefinitely; use
        it for receivers that already parse the Moosewave audit shape.
      </div>
    );
  }
  return (
    <div
      role="note"
      className="space-y-2 rounded-md border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground"
    >
      <p>
        <strong className="text-foreground">OCSF 1.8</strong> — the Linux
        Foundation schema consumed natively by Splunk, Datadog Cloud SIEM,
        Microsoft Sentinel Data Lake, Google SecOps, and AWS Security Lake.
      </p>
      <p>
        Moosewave routes actions to OCSF classes 3001 (Account Change), 3002
        (Authentication), 3004 (Entity Management), and 6003 (API Activity).
        Pair this format with the bundled Sigma rule pack (
        <code>docs/sigma/postwave/rules/</code> in the Moosewave repository) for
        ready-to-use detections.
      </p>
      <details>
        <summary className="cursor-pointer font-medium text-foreground">
          Sample event
        </summary>
        {/* Focusable so a keyboard-only reader can scroll the wide sample;
            role="group" names it without adding a landmark. */}
        <pre
          tabIndex={0}
          role="group"
          aria-label="OCSF sample event"
          className="mt-2 overflow-x-auto rounded bg-background p-2 font-mono text-[11px] leading-4 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {OCSF_SAMPLE_EVENT}
        </pre>
      </details>
      <p>
        Full field mapping: <code>docs/audit/ocsf-mapping.md</code> in the
        Moosewave repository.
      </p>
    </div>
  );
}
