/**
 * lib/campaignRenderPreview.ts — reading the two rendered-preview services.
 *
 *   POST /api/v1/email-preview/render   {mjml, vars} →
 *        {previews: {gmail|outlook|apple|dark: html}, warnings, renderer}
 *        (apps/api/internal/emailpreview/handlers.go renderRequest/-Response;
 *        plain HTML travels through the stub renderer, so the body field —
 *        which is HTML across this app — is a legal `mjml` value.)
 *   POST /api/v1/render                 {html} → {renders: [...]}
 *        (deliverability-service proxy; paid + slow, so it only ever runs
 *        from an explicit press — mirroring desktop's CrossClientPreview.)
 *
 * Both routes are session-role ADMIN in the routeauth manifest, which is why
 * the sheet that consumes this module is offered to admins only.
 *
 * `isolatedPreviewDocument` mirrors desktop's EmailPreviewTabs: the email body
 * is arbitrary third-party HTML, so the injected CSP forbids scripts, network
 * fetches, frames and forms before it goes anywhere near a WebView. The
 * WebView itself additionally disables JS — the CSP is the second lock.
 */

export interface EmailPreviewClient {
  id: "gmail" | "outlook" | "apple" | "dark";
  label: string;
  /** The client's typical viewport width; becomes the WebView viewport. */
  width: number;
}

/** Mirrors desktop's CLIENTS list (EmailPreviewTabs.tsx:55). */
export const EMAIL_PREVIEW_CLIENTS: readonly EmailPreviewClient[] = [
  { id: "gmail", label: "Gmail", width: 600 },
  { id: "outlook", label: "Outlook", width: 580 },
  { id: "apple", label: "Apple Mail", width: 375 },
  { id: "dark", label: "Dark mode", width: 600 },
];

export interface EmailRenderReading {
  /** Keyed by client id; a missing key renders as an honest empty state. */
  previews: Partial<Record<EmailPreviewClient["id"], string>>;
  warnings: string[];
  /** "mjml" | "engine" | "fallback" — fallback means unprocessed body. */
  renderer: string;
}

export function readEmailRender(data: unknown): EmailRenderReading | null {
  if (!data || typeof data !== "object") return null;
  const body = data as {
    previews?: unknown;
    warnings?: unknown;
    renderer?: unknown;
  };
  const rawPreviews =
    body.previews && typeof body.previews === "object"
      ? (body.previews as Record<string, unknown>)
      : {};
  const previews: EmailRenderReading["previews"] = {};
  for (const client of EMAIL_PREVIEW_CLIENTS) {
    const html = rawPreviews[client.id];
    if (typeof html === "string" && html.trim() !== "") {
      previews[client.id] = html;
    }
  }
  return {
    previews,
    warnings: Array.isArray(body.warnings)
      ? body.warnings.filter((w): w is string => typeof w === "string")
      : [],
    renderer: typeof body.renderer === "string" ? body.renderer : "",
  };
}

/**
 * Same policy string desktop injects (EmailPreviewTabs.tsx PREVIEW_CSP):
 * no scripts, no network, images from data:/blob: only.
 */
const PREVIEW_CSP =
  "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; frame-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'";

/**
 * Wrap a rendered body for display: inject the lockdown CSP and a viewport
 * matched to the client's width so the WebView lays the email out at the
 * width that client actually gives it.
 */
export function isolatedPreviewDocument(html: string, width: number): string {
  const meta =
    `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">` +
    `<meta name="viewport" content="width=${Math.max(320, Math.round(width))}">`;
  // ALWAYS wrap. Never splice into the untrusted document.
  //
  // Splicing at the first `<head`-shaped substring let the document choose
  // where the policy landed: `<!--<head>-->`, `<title><head></title>` and
  // `href="?x=<head>"` all matched first, so the entire CSP was emitted INSIDE
  // a comment, a title or an attribute and the real <head> that followed
  // carried none. The preview then loaded remote images, fonts, CSS and
  // frames — a beacon carrying the reviewer's IP and the moment they looked.
  //
  // Wrapping is safe because the parser ignores a nested <html>/<head> inside
  // the body, their <style>/<link> still apply, and per spec a
  // <meta http-equiv="Content-Security-Policy"> outside <head> is ignored —
  // so the policy injected here is the only one this document can ever have.
  return `<!doctype html><html><head>${meta}</head><body>${html}</body></html>`;
}

/* ---------- cross-client screenshot matrix (POST /api/v1/render) -------- */

export interface CrossClientTile {
  name: string;
  darkMode: boolean;
  /** https only — anything else is dropped rather than fetched. */
  imageUrl: string | null;
  issues: string[];
}

function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function readCrossClientRenders(data: unknown): CrossClientTile[] {
  if (!data || typeof data !== "object") return [];
  const renders = (data as { renders?: unknown }).renders;
  if (!Array.isArray(renders)) return [];
  const out: CrossClientTile[] = [];
  for (const item of renders) {
    if (!item || typeof item !== "object") continue;
    const row = item as {
      environment?: { name?: unknown; dark_mode?: unknown };
      image_url?: unknown;
      issues?: unknown;
    };
    const name =
      typeof row.environment?.name === "string"
        ? row.environment.name.trim()
        : "";
    if (!name) continue;
    out.push({
      name,
      darkMode: row.environment?.dark_mode === true,
      imageUrl: safeHttpsUrl(row.image_url),
      issues: Array.isArray(row.issues)
        ? row.issues.filter((i): i is string => typeof i === "string")
        : [],
    });
  }
  return out;
}
