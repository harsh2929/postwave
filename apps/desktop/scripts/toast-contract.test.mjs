import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  auditToastSourceText,
  validateCriticalNoticeCatalog,
} from "./toast-contract.mjs";

const codes = new Set(["recovery-unavailable"]);

describe("desktop toast caller contract", () => {
  it("classifies direct calls and accepts literal catalog codes", () => {
    const result = auditToastSourceText({
      fileName: "src/Example.tsx",
      catalogCodes: codes,
      sourceText: `
        import { toast as notice } from "../components/Toast";
        notice.success("Saved");
        notice.error({ message: "Retry" });
        notice.critical("recovery-unavailable");
        notice.resolveCritical("recovery-unavailable");
      `,
    });
    assert.deepEqual(result.findings, []);
    assert.deepEqual(
      result.calls.map((call) => call.method),
      ["success", "error", "critical", "resolveCritical"],
    );
  });

  it("rejects arbitrary sticky copy and zero-duration bypasses", () => {
    const result = auditToastSourceText({
      fileName: "src/Unsafe.tsx",
      catalogCodes: codes,
      sourceText: `
        import { toast } from "../components/Toast";
        toast.error({ message: serverMessage, persistent: true });
        toast.info({ message: "Wait", duration: 0 });
      `,
    });
    assert.match(result.findings.join("\n"), /arbitrary persistent copy/);
    assert.match(result.findings.join("\n"), /duration 0 bypasses/);
  });

  it("rejects dynamic, unknown, extra-argument, aliased, and unknown calls", () => {
    const result = auditToastSourceText({
      fileName: "src/Unsafe.ts",
      catalogCodes: codes,
      sourceText: `
        import { toast } from "../components/Toast";
        toast.critical(code);
        toast.resolveCritical("unknown");
        toast.critical("recovery-unavailable", serverMessage);
        const fail = toast.error;
        toast.warning("Nope");
      `,
    });
    const findings = result.findings.join("\n");
    assert.match(findings, /requires a literal catalog code/);
    assert.match(findings, /unknown critical notice code/);
    assert.match(findings, /accepts exactly one code argument/);
    assert.match(findings, /aliases\/destructuring bypass classification/);
    assert.match(findings, /unsupported toast method warning/);
  });

  it("validates bounded, fixed catalog copy", () => {
    assert.deepEqual(
      validateCriticalNoticeCatalog({
        "recovery-unavailable": { message: "Recovery failed", detail: "Retry." },
      }),
      [],
    );
    const findings = validateCriticalNoticeCatalog({
      BAD: { message: " unsafe ", detail: "ok", resourceId: "private" },
    }).join("\n");
    assert.match(findings, /invalid critical notice code/);
    assert.match(findings, /message must be clean/);
    assert.match(findings, /unsupported catalog fields resourceId/);
  });
});
