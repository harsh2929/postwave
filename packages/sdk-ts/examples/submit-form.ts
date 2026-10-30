/**
 * Submit a public form (no auth) and check the resulting submission state.
 *
 * Run:  tsx examples/submit-form.ts
 */
import { PostwaveClient } from "@postwave/sdk";

// API key is unused for public form submit, but the client still needs one.
// In production the public form posts directly from the browser.
const pw = new PostwaveClient({
  apiKey: "anon",
  baseUrl: process.env.POSTWAVE_BASE ?? "https://api.moosewave.com",
});

async function main(): Promise<void> {
  const slug = process.env.FORM_SLUG ?? "newsletter";
  const result = await pw.request<{ ok: boolean; state: string; message?: string }>(
    "POST",
    `/api/public/forms/${encodeURIComponent(slug)}/submit`,
    {
      body: {
        email: "test@example.com",
        name: "Test User",
        consent: "yes",
        customFields: { source: "sdk-example" },
      },
    },
  );
  console.log(result);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
