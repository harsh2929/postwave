/**
 * PasswordRequirements — live 4-item checklist under a password field.
 *
 * Replaces (or supplements) the strength bar so the user knows WHAT
 * to add, not just "weak/medium/strong". Each rule turns green when
 * satisfied; the parent uses `allOk` to gate submit.
 */

import type { ReactElement } from "react";

interface Props {
  value: string;
}

export interface PasswordRules {
  length: boolean;
  upper: boolean;
  number: boolean;
  symbol: boolean;
}

export function evaluatePassword(value: string): PasswordRules {
  return {
    length: value.length >= 12,
    upper: /[A-Z]/.test(value),
    number: /\d/.test(value),
    symbol: /[^A-Za-z0-9]/.test(value),
  };
}

export function allPasswordRulesPass(value: string): boolean {
  const r = evaluatePassword(value);
  return r.length && r.upper && r.number && r.symbol;
}

function Check({ ok }: { ok: boolean }): ReactElement {
  return (
    <span
      className={`auth-pw-check${ok ? " is-ok" : ""}`}
    >
      <svg
        width="11"
        height="11"
        viewBox="0 0 14 14"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path className="auth-pw-check-tick" d="M3 7l3 3 5-6" />
        <path className="auth-pw-check-cross" d="M3 3l8 8M11 3l-8 8" />
      </svg>
    </span>
  );
}

export function PasswordRequirements({ value }: Props): ReactElement {
  const r = evaluatePassword(value);
  return (
    <div className="auth-pw-checklist" role="list" aria-label="Password requirements">
      <span className={`auth-pw-check${r.length ? " is-ok" : ""}`} role="listitem">
        <Check ok={r.length} /> 12+ characters
      </span>
      <span className={`auth-pw-check${r.upper ? " is-ok" : ""}`} role="listitem">
        <Check ok={r.upper} /> Uppercase letter
      </span>
      <span className={`auth-pw-check${r.number ? " is-ok" : ""}`} role="listitem">
        <Check ok={r.number} /> Number
      </span>
      <span className={`auth-pw-check${r.symbol ? " is-ok" : ""}`} role="listitem">
        <Check ok={r.symbol} /> Symbol
      </span>
    </div>
  );
}
