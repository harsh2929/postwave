const AUTH_FAILURE_PATTERNS = [
  /\bauth(?:entication)?\b/i,
  /\bapi[_ -]?key\b/i,
  /\bapi[_ -]?token\b/i,
  /\baccount api url\b/i,
  /\baccess[_ -]?token\b/i,
  /\brefresh[_ -]?token\b/i,
  /\bunauthorized\b/i,
  /\bforbidden\b/i,
  /\binvalid token\b/i,
  /\bbad token\b/i,
  /\btoken (?:expired|revoked|invalid)\b/i,
  /\b(?:http\s*)?401\b/i,
  /\b(?:http\s*)?403\b/i,
  /\bstatus\s*40[13]\b/i,
  /\b40[13]\s*(?:response|error)\b/i,
];

export function isMigrationAuthFailureMessage(message: string): boolean {
  return AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(message));
}
