// The outbound retention win-back worker exists as a package implementation,
// but no production composition root constructs or runs it. Keep public copy
// count-neutral and explicit until mounted delivery, provider, consent,
// suppression, reconciliation, and live certification evidence all exist.
export const RETENTION_WINBACK_RELEASE_HOLD_CODE =
  "ASSURE-F15-WINBACK-DISPATCH-UNWIRED" as const;

export const RETENTION_WINBACK_RELEASE_VERDICT = "rollout-held" as const;
