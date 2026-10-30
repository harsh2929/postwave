const LANDING_CONVERSION_TIMEOUT_MS = positiveIntEnv(
  "NEXT_PUBLIC_PUBLIC_PAGE_TIMEOUT_MS",
  8_000,
  1_000,
);

function positiveIntEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return Math.floor(parsed);
}

export async function submitLandingConversion(
  slug: string,
  email: string,
  // LAND-037: the opaque signed token the serve response handed us; echoing it
  // attributes this conversion to the A/B arm the visitor was actually served.
  variantToken?: string,
): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LANDING_CONVERSION_TIMEOUT_MS);
  try {
    const res = await fetch(
      `/api/public/landing-pages/${encodeURIComponent(slug)}/convert`,
      {
        method: "POST",
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          email,
          metadata: { source: "hosted_landing_page" },
          ...(variantToken ? { variant_token: variantToken } : {}),
        }),
      },
    );
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
