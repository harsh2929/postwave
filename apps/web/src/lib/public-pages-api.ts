import type { Form, PublicForm } from "@/lib/forms-types";
import { isMockModeEnabled } from "@/lib/mock-mode";
import {
  decodePublicPreferenceLookup,
  type PreferenceLookupResponse,
} from "@/lib/preferences-api";

const DEFAULT_BASE_URL =
  process.env.POSTWAVE_API_URL ||
  process.env.API_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  "http://localhost:8080";
const USE_MOCKS = isMockModeEnabled();
const PUBLIC_PAGE_TIMEOUT_MS = positiveIntEnv(
  ["POSTWAVE_PUBLIC_PAGE_TIMEOUT_MS", "NEXT_PUBLIC_PUBLIC_PAGE_TIMEOUT_MS"],
  8_000,
  1_000,
);
const MAX_PUBLIC_JSON_BYTES = 512 * 1024;

function positiveIntEnv(
  names: string[],
  fallback: number,
  min: number,
): number {
  for (const name of names) {
    const raw = process.env[name];
    if (!raw) continue;
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= min) return Math.floor(parsed);
  }
  return fallback;
}

export type PublicLookupResult<T> =
  | { kind: "ok"; data: T }
  | { kind: "missing" }
  | { kind: "expired" }
  | { kind: "unavailable" };

export type PublicConfirmState =
  | "confirmed"
  | "already"
  | "missing"
  // The link was real and its window closed. Distinct from "missing" (a broken
  // or tampered token) and from "unavailable" (we could not reach the service):
  // an expired link needs "sign up again", and the other two do not.
  | "expired"
  | "unavailable";

interface PublicConfirmResponse {
  state?: PublicConfirmState;
}

export interface LandingPageRecord {
  id: string;
  slug: string;
  name: string;
  status: "draft" | "published" | "archived";
  template: string;
  blocks: Array<Record<string, unknown>>;
  seo: Record<string, unknown>;
  // LAND-037: present when the served page is an A/B variant. Opaque, signed,
  // page-bound. The subscribe form echoes it on conversion for attribution.
  variant_token?: string;
}

/**
 * Reads a form's configured success message for the hosted success page.
 *
 * The success page is only reached after a submission, so this lookup is not a
 * render: it says so with the header the API honours
 * (forms.PublicLookupPurposeHeader), or every conversion would also count as a
 * visit and depress the form's conversion rate. A form that cannot be read
 * answers with an empty string, and the page keeps its translated default —
 * a success page never shows an error for something the visitor already did.
 */
export async function fetchPublicFormSuccessMessage(
  slug: string,
  baseUrl: string = DEFAULT_BASE_URL,
): Promise<string> {
  const result = await fetchPublicForm(slug, baseUrl, {
    countsAsRender: false,
  });
  if (result.kind !== "ok") return "";
  return (result.data.settings?.successMessage ?? "").trim();
}

export async function fetchPublicForm(
  slug: string,
  baseUrl: string = DEFAULT_BASE_URL,
  options: { countsAsRender?: boolean } = {},
): Promise<PublicLookupResult<PublicForm>> {
  if (!safePublicPathToken(slug)) return { kind: "missing" };
  if (USE_MOCKS) {
    const form = await mockFormBySlug(slug);
    return form ? { kind: "ok", data: form } : { kind: "missing" };
  }
  try {
    // Do not reconstruct X-Forwarded-For from request headers here. This is a
    // server-to-server render lookup, and the RSC process cannot authenticate
    // which upstream wrote that header. The API gives this read-only route its
    // own traffic-shaped limiter, independent from form submission abuse.
    const res = await publicFetch(
      publicApiURL(baseUrl, `/api/public/forms/${encodeURIComponent(slug)}`),
      undefined,
      options.countsAsRender === false
        ? { "X-Postwave-Form-Lookup": "success-copy" }
        : undefined,
    );
    if (res.status === 404) return { kind: "missing" };
    if (!res.ok) return { kind: "unavailable" };
    const body = (await readJsonLimited(res)) as {
      form?: PublicForm;
      captcha_required?: boolean;
      recaptcha_site_key?: string;
    };
    return body.form
      ? {
          kind: "ok",
          data: {
            ...body.form,
            captchaRequired: body.captcha_required === true,
            recaptchaSiteKey: body.recaptcha_site_key || undefined,
          },
        }
      : { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
}

export async function fetchPublicPreferences(
  token: string,
  baseUrl: string = DEFAULT_BASE_URL,
  visitorIP?: string,
): Promise<PublicLookupResult<PreferenceLookupResponse>> {
  if (!safePublicPathToken(token, 2048)) return { kind: "missing" };
  if (USE_MOCKS) {
    if (token.startsWith("expired_")) return { kind: "expired" };
    if (token.startsWith("missing_")) return { kind: "missing" };
    if (token.startsWith("unavailable_")) return { kind: "unavailable" };
    const { mockPublicLookup } = await import("@/lib/preferences-mocks");
    return { kind: "ok", data: mockPublicLookup(token) };
  }
  try {
    const res = await publicFetch(
      publicApiURL(
        baseUrl,
        `/api/public/preferences/${encodeURIComponent(token)}`,
      ),
      visitorIP,
    );
    if (res.status === 410) return { kind: "expired" };
    if (res.status === 404) return { kind: "missing" };
    if (!res.ok) return { kind: "unavailable" };
    return {
      kind: "ok",
      data: decodePublicPreferenceLookup(await readJsonLimited(res)),
    };
  } catch {
    return { kind: "unavailable" };
  }
}

export async function fetchPublicLandingPage(
  slug: string,
  baseUrl: string = DEFAULT_BASE_URL,
  visitorIP?: string,
): Promise<PublicLookupResult<LandingPageRecord>> {
  if (!safePublicPathToken(slug)) return { kind: "missing" };
  if (USE_MOCKS) {
    if (slug === "unavailable-launch") return { kind: "unavailable" };
    const page = mockLandingBySlug(slug);
    return page ? { kind: "ok", data: page } : { kind: "missing" };
  }
  try {
    const res = await publicFetch(
      publicApiURL(
        baseUrl,
        `/api/public/landing-pages/${encodeURIComponent(slug)}`,
      ),
      visitorIP,
    );
    if (res.status === 404) return { kind: "missing" };
    if (!res.ok) return { kind: "unavailable" };
    return {
      kind: "ok",
      data: (await readJsonLimited(res)) as LandingPageRecord,
    };
  } catch {
    return { kind: "unavailable" };
  }
}

export async function confirmPublicFormToken(
  token: string,
  baseUrl: string = DEFAULT_BASE_URL,
): Promise<PublicConfirmState> {
  if (!safePublicPathToken(token, 2048)) return "missing";
  if (USE_MOCKS) {
    if (token.startsWith("already_")) return "already";
    if (token.startsWith("expired_")) return "expired";
    if (token.startsWith("missing_")) return "missing";
    if (token.startsWith("unavailable_")) return "unavailable";
    return "confirmed";
  }
  try {
    // Confirmation is token-bearing and rate-limited in its own API namespace.
    // Never turn an unauthenticated inbound forwarding header into trusted
    // server-to-server identity.
    const res = await publicFetch(
      publicApiURL(
        baseUrl,
        `/api/public/forms/confirm/${encodeURIComponent(token)}`,
      ),
    );
    if (res.status === 404) return "missing";
    // 410 Gone. Without this the expired case fell to `!res.ok` and rendered
    // "Confirmation temporarily unavailable — refresh in a moment; your link has
    // not been marked invalid": the service WAS reached, refreshing will never
    // work, and the link HAS been invalidated. Every clause was false.
    // `fetchPreferences` above already maps 410 this way.
    if (res.status === 410) return "expired";
    if (!res.ok) return "unavailable";
    const body = (await readJsonLimited(res)) as PublicConfirmResponse;
    return body.state === "confirmed" || body.state === "already"
      ? body.state
      : "confirmed";
  } catch {
    return "unavailable";
  }
}

function publicApiURL(baseUrl: string, path: string): string {
  const normalized = normalizePublicApiBaseURL(baseUrl);
  return new URL(`./${path.replace(/^\/+/, "")}`, `${normalized}/`).toString();
}

function normalizePublicApiBaseURL(baseUrl: string): string {
  const raw = baseUrl.trim().replace(/\/+$/, "");
  if (!raw || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new Error("public API base URL must be valid");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("public API base URL must be valid");
  }
  if (parsed.protocol === "http:") {
    if (!isLocalHTTPHost(parsed.hostname)) {
      throw new Error(
        "public API base URL must use https outside local development",
      );
    }
  } else if (parsed.protocol !== "https:") {
    throw new Error("public API base URL must use http(s)");
  }
  if (parsed.username || parsed.password) {
    throw new Error("public API base URL must not include credentials");
  }
  if (parsed.search || parsed.hash) {
    throw new Error(
      "public API base URL must not include a query string or fragment",
    );
  }
  return parsed.toString().replace(/\/+$/, "");
}

function isLocalHTTPHost(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  );
}

function safePublicPathToken(value: string, maxLength = 256): boolean {
  if (!value || value.length > maxLength) return false;
  if (value !== value.trim()) return false;
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return false;
  if (value.includes("/") || value.includes("?") || value.includes("#"))
    return false;
  let decoded = value;
  for (let i = 0; i < 2; i += 1) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      break;
    }
  }
  if (!decoded || decoded === "." || decoded === "..") return false;
  if (
    decoded.includes("/") ||
    decoded.includes("\\") ||
    decoded.includes("?") ||
    decoded.includes("#")
  ) {
    return false;
  }
  return true;
}

/** Hard cap on forwarded hops. A real chain is 1-3 entries; anything longer is
 *  a client stuffing the header, so the chain is dropped rather than relayed. */
const MAX_FORWARDED_HOPS = 16;

/**
 * The X-Forwarded-For value to relay on the server-to-server hop, or "" when
 * there is nothing trustworthy to relay.
 *
 * This returns the WHOLE inbound chain, not one entry. The API is the component
 * that decides which hop is the real client, and it does so by walking
 * X-Forwarded-For from the RIGHT (apps/api/internal/middleware/client_ip.go) —
 * precisely because a client can prepend anything it likes before the request
 * reaches a proxy, so only the entries a trusted proxy appended are meaningful.
 *
 * Collapsing the chain to its leftmost entry destroys that: the sole surviving
 * entry is the fully attacker-chosen one, and the API's rightmost walk then
 * returns it as the client IP. That let a caller mint a fresh rate-limit bucket
 * per request against the 10/min public landing-page budget and fabricate the
 * IP recorded on the landing view event. Relaying the chain verbatim keeps the
 * proxy-appended entries in place so the rightmost walk lands on the real peer.
 *
 * Every hop must still be a bare IP literal — that is what keeps an
 * attacker-controlled header from becoming a second header line or an arbitrary
 * rate-limit key — and one malformed hop voids the whole chain, mirroring how
 * the API refuses to walk past an unparseable entry.
 */
export function visitorIPFromHeaders(headers: Pick<Headers, "get">): string {
  const raw = headers.get("x-forwarded-for") || headers.get("x-real-ip") || "";
  if (!raw) return "";
  const hops = raw.split(",");
  if (hops.length > MAX_FORWARDED_HOPS) return "";
  const chain: string[] = [];
  for (const hop of hops) {
    const value = hop.trim();
    if (!/^[0-9a-f:.]+$/i.test(value) || value.length > 64) return "";
    chain.push(value);
  }
  return chain.join(", ");
}

async function publicFetch(
  url: string,
  visitorIP?: string,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PUBLIC_PAGE_TIMEOUT_MS);
  try {
    return await fetch(url, {
      cache: "no-store",
      credentials: "omit",
      headers: {
        accept: "application/json",
        ...(visitorIP ? { "X-Forwarded-For": visitorIP } : {}),
        ...extraHeaders,
      },
      redirect: "error",
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonLimited(res: Response): Promise<unknown> {
  const text = await readTextLimited(res);
  if (!text) return null;
  return JSON.parse(text) as unknown;
}

async function readTextLimited(res: Response): Promise<string> {
  const contentLength = Number(res.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_PUBLIC_JSON_BYTES) {
    throw new Error("public JSON response too large");
  }
  if (!res.body) {
    const read = res.text.bind(res);
    const text = await read();
    if (new TextEncoder().encode(text).byteLength > MAX_PUBLIC_JSON_BYTES) {
      throw new Error("public JSON response too large");
    }
    return text;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PUBLIC_JSON_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("public JSON response too large");
    }
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

async function mockFormBySlug(slug: string): Promise<Form | null> {
  const { mockGetForm, mockListForms } = await import("@/lib/forms-mocks");
  const all = mockListForms();
  const item = all.find((f) => f.slug.toLowerCase() === slug.toLowerCase());
  if (!item) return null;
  if (item.status !== "published") return null;
  return mockGetForm(item.id);
}

function mockLandingBySlug(slug: string): LandingPageRecord | null {
  if (slug !== "demo-launch" && slug !== "draft-launch") return null;
  return {
    id: slug === "demo-launch" ? "landing_demo_launch" : "landing_draft_launch",
    slug,
    name: "The Signal Brief",
    status: slug === "demo-launch" ? "published" : "draft",
    template: "Editorial launch",
    blocks: [
      {
        type: "hero",
        heading: "The sharpest ideas in your inbox, once a week",
        body: "A concise field note for independent writers and thoughtful teams — practical examples, honest trade-offs, and no filler.",
      },
      {
        type: "feature",
        heading: "Useful in five minutes",
        body: "One tested playbook you can put to work before your next send.",
      },
      {
        type: "feature",
        heading: "Built on real evidence",
        body: "Screenshots, numbers, and lessons from campaigns that actually shipped.",
      },
      {
        type: "feature",
        heading: "Respectful by design",
        body: "No daily drip, no inbox games, and a one-click way out whenever you want it.",
      },
      { type: "signup_form", button: "Join the brief" },
    ],
    seo: {
      title: "The Signal Brief — practical email field notes",
      description:
        "A concise weekly field note for independent writers and thoughtful teams.",
    },
    variant_token: "demo_variant_control",
  };
}
