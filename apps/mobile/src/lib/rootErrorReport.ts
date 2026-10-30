/**
 * lib/rootErrorReport.ts — what the root error boundary can tell a human
 * (NATIVE#41).
 *
 * The boundary reported the crash to Sentry and showed the user nothing they
 * could act on: no reference, no release, no way to send it on. Support then
 * had to correlate "the app broke this morning" against every event in the
 * project.
 *
 * Pure by design — no react-native, no Sentry — so the redaction rules are
 * unit-tested in the node environment. The boundary itself must keep working
 * when the thing that crashed was a provider, so it can only depend on modules
 * that need no context.
 */

const MAX_MESSAGE_CHARS = 200;
const MAX_FIELD_CHARS = 64;
/** Matches the server's `x-request-id` grammar (see api/request.ts). */
const REQUEST_ID_RE = /^[A-Za-z0-9/_.-]{1,64}$/;
const RELEASE_RE = /^[A-Za-z0-9@._+-]{1,64}$/;

export interface RootErrorReport {
  /** Short human title, always present. */
  name: string;
  /** Redacted message, or null when there is nothing safe to show. */
  message: string | null;
  /** Server correlation id, when the crash carried one. */
  requestId: string | null;
  /** Build identifier, when the app declares one. */
  release: string | null;
  /** Single-line reference the user can read aloud to support. */
  reference: string;
}

function boundedField(value: unknown, pattern: RegExp): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || !pattern.test(trimmed)) return null;
  return trimmed;
}

/**
 * Strip the things a crash message most often carries by accident before it is
 * put on a screen the user may screenshot into a shared channel: emails,
 * bearer/API tokens, and long opaque blobs.
 */
export function redactErrorMessage(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const scrubbed = raw
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]")
    .replace(/\b(pw_|sk_|Bearer\s+)[A-Za-z0-9._-]{6,}/gi, "[redacted]")
    .replace(/\b[A-Za-z0-9._-]{40,}\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  if (!scrubbed) return null;
  return scrubbed.length > MAX_MESSAGE_CHARS
    ? `${scrubbed.slice(0, MAX_MESSAGE_CHARS - 1)}…`
    : scrubbed;
}

/**
 * Build everything the recovery card shows. `release` normally comes from
 * EXPO_PUBLIC_POSTWAVE_RELEASE; it is passed in so the builder stays pure.
 */
export function buildRootErrorReport(
  error: unknown,
  release?: string | undefined,
): RootErrorReport {
  const record =
    error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const name =
    boundedField(record.name, /^[A-Za-z][A-Za-z0-9 _-]{0,63}$/) ?? "Error";
  const message = redactErrorMessage(record.message);
  const requestId = boundedField(record.requestId, REQUEST_ID_RE);
  const safeRelease = boundedField(release, RELEASE_RE);
  const parts = [name];
  if (requestId) parts.push(`ref ${requestId}`);
  if (safeRelease) parts.push(safeRelease);
  return {
    name,
    message,
    requestId,
    release: safeRelease,
    reference: parts.join(" · ").slice(0, MAX_FIELD_CHARS * 3),
  };
}

/** The block shared through the OS share sheet. Newline-separated, no PII. */
export function rootErrorShareText(report: RootErrorReport): string {
  return [
    "Moosewave app error",
    `Type: ${report.name}`,
    report.message ? `Detail: ${report.message}` : null,
    report.requestId ? `Reference: ${report.requestId}` : null,
    report.release ? `Build: ${report.release}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}
