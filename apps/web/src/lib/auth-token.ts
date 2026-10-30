const MAX_AUTH_TOKEN_CHARS = 2048;

export function safeAuthTokenParam(value: string | null): string | null {
  if (!value || value.length > MAX_AUTH_TOKEN_CHARS) return null;
  return value;
}
