// SPDX-License-Identifier: AGPL-3.0-only
//
// SEO intent: rank for "AI newsletter writing in my voice", "brand voice AI
// email", "AI email sequence generator", "voice-trained email AI". Primary
// intent is the writer/operator evaluating whether Moosewave's AI sounds like
// them — not like a chatbot — across sequences and the rest of the app.
import type { Metadata } from "next";
import Link from "next/link";

import {
  ProductShot,
  type ProductShotVariant,
} from "@/components/marketing/product-shot";
import {
  JsonLd,
  breadcrumbSchema,
  faqPageSchema,
  type FaqEntry,
} from "@/components/seo/json-ld";
import { MCP_RELEASE_HOLD_CODE } from "@/lib/mcp-release-status";

const PAGE_URL = "https://moosewave.com/voice";
const PAGE_DESCRIPTION =
  "Train an AI voice profile on what you've already written, then generate launch sequences that read like you wrote them — with a per-email fidelity score that auto-regenerates anything under 60.";

export const metadata: Metadata = {
  title: "Voice AI: sequences in your actual voice | Moosewave",
  description: PAGE_DESCRIPTION,
  alternates: { canonical: PAGE_URL },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    url: PAGE_URL,
    title: "Moosewave Voice AI: sequences in your voice, not chatbot voice",
    description: PAGE_DESCRIPTION,
    siteName: "Moosewave",
    locale: "en_US",
    images: [
      {
        url: "/voice/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Moosewave Voice AI overview",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Moosewave Voice AI: sequences in your voice, not chatbot voice",
    description: PAGE_DESCRIPTION,
    creator: "@moosewave",
  },
};

const FAQ: FaqEntry[] = [
  {
    question: "Can Moosewave's Voice AI actually write in my voice?",
    answer:
      "Yes. You build a voice profile from up to six source types: your imported newsletter archive, Twitter or X, a blog RSS feed, podcast transcripts, LinkedIn, or text you paste directly. URL-bearing sources (RSS, blog) are SSRF-validated before ingestion; pasted samples are stored in place. The profile combines stylistic features, a vocabulary fingerprint, structural patterns, a tonal vector, and persona signals — so generations carry your phrasing and pacing, not a generic assistant tone.",
  },
  {
    question:
      "How does Moosewave know whether a generated email sounds like me?",
    answer:
      "Every generated email gets a 0–100 voice-fidelity score combining embedding cosine similarity, stylistic-feature distance, vocabulary alignment, and structural fit, returned with a sub-score breakdown. Anything below 60 is auto-flagged for regeneration before you ever see it, so you don't get the bad drafts. The per-email scores render right on the sequence editor next to each email.",
  },
  {
    question: "What sequences can I generate?",
    answer:
      "50 launch templates across 13 categories: welcome series, course launch, product launch, re-engagement, newsletter series, SaaS onboarding, partnership announcements, year-in-review, crisis or apology, cold-warm transition, community, sales, and general-purpose. Each template auto-extracts its variables (product name, launch date, audience description) and renders them as a form, so non-technical users customize without touching prompts. A seven-email welcome series generates in one pass, each email individually scored.",
  },
  {
    question: "Can I edit what the AI writes?",
    answer:
      "Yes. Regenerate one email with an optional hint ('shorter', 'more direct opening') plus four style sliders — humor, directness, length, and formality. Moosewave returns a non-persisting candidate for review; accepting it uses the exact sequence version you reviewed, so a concurrent edit cannot be overwritten silently. The rest of the sequence stays unchanged.",
  },
  {
    question: "What else uses Voice AI besides sequences?",
    answer:
      "The same voice layer powers AI subject-line generation (a plain-English brief in, distinct candidates out, with a 90-day top-performers panel for inspiration), AI broadcast compose (brief to A/B-ready draft), brand-voice synthesis for on-brand microcopy across the app, an AI segment compiler that turns natural language into validated segment logic, a preview-only content optimizer for multi-arm subject/body allocation, and a subject analyzer that correlates subject attributes with your own list's open and click rates. Optimizer previews are not persisted or applied by send workers.",
  },
  {
    question: "Do you train your models on my data?",
    answer:
      "No. We never train models on your subscriber data or your generated content, and voice profiles stay scoped to your workspace. AI calls route through a per-request, tenant-scoped PII gateway that tokenizes configured sensitive values before the model sees them and restores them in the response — so personal data in a prompt isn't shipped to the provider in the clear.",
  },
];

const BREADCRUMBS = breadcrumbSchema([
  { name: "Home", url: "https://moosewave.com" },
  { name: "Voice AI", url: PAGE_URL },
]);

const PRODUCT_JSON_LD = {
  "@context": "https://schema.org" as const,
  "@type": "Product",
  name: "Moosewave — Voice AI",
  description: PAGE_DESCRIPTION,
  brand: { "@type": "Brand", name: "Moosewave" },
  url: PAGE_URL,
  category: "Newsletter and email marketing platform",
  offers: {
    "@type": "AggregateOffer",
    priceCurrency: "USD",
    lowPrice: "0",
    highPrice: "349",
    offerCount: "4",
    url: "https://moosewave.com/pricing",
  },
};

interface Screenshot {
  alt: string;
  variant: ProductShotVariant;
}

interface Section {
  id: string;
  number: string;
  eyebrow: string;
  title: string;
  subhead: string;
  bullets: string[];
  shots: Screenshot[];
}

const SECTIONS: Section[] = [
  {
    id: "voice-profile",
    number: "1.0",
    eyebrow: "Voice profile",
    title: "Train once on what you've already written.",
    subhead:
      "You don't describe your voice in a text box. Moosewave learns it from your real writing — up to six source types — and compiles a profile the generator conditions on every time.",
    bullets: [
      "Voice profile built from up to six source types: imported newsletter archive (from your migration), Twitter / X, blog RSS, podcast transcripts, LinkedIn, or pasted samples.",
      "URL-bearing sources (RSS, blog) are SSRF-validated before fetch; pasted text and transcripts are stored in place. Add sources incrementally, then rebuild.",
      "Profile = stylistic features + vocabulary fingerprint + structural patterns + tonal vector + persona signals. It's how a generation carries your phrasing and pacing, not a generic assistant register.",
      "Rebuilding re-computes the profile from all currently-ingested sources — add a new podcast season or a quarter of newsletters, rebuild, and every future generation reflects it.",
      "Separately, you can author an explicit brand-voice profile: descriptors, writing rules, and sample snippets, with prohibition cues ('never say synergy') parsed into banned terms the drift check penalizes.",
      "The profile gets read into context on every voice surface — sequences, subject lines, compose — so 'your voice' is one thing, applied everywhere, not re-specified per feature.",
    ],
    shots: [
      {
        alt: "Voice profile page with stylistic feature chart, vocabulary fingerprint, and the list of ingested sources",
        variant: "voice",
      },
      {
        alt: "Voice source picker: newsletter archive, Twitter / X, blog RSS, podcast transcripts, LinkedIn, pasted samples",
        variant: "voice",
      },
      {
        alt: "Authored brand-voice profile editor with descriptors, writing rules, and sample snippets",
        variant: "voice",
      },
    ],
  },
  {
    id: "sequences",
    number: "2.0",
    eyebrow: "Sequences",
    title: "Pick a template. Get a sequence that reads like you.",
    subhead:
      "50 launch templates across 13 categories. Variables are auto-extracted and rendered as a form, so a non-technical operator customizes a multi-email launch without ever touching a prompt.",
    bullets: [
      "50 launch templates spanning welcome series, course launch, product launch, re-engagement, newsletter series, SaaS onboarding, partnership announcements, year-in-review, crisis / apology, cold-warm transition, community, sales, and general-purpose.",
      "Each generation runs through your voice profile, so a seven-email welcome series comes back in your phrasing — not ten variations of the same chatbot opener.",
      "Variables auto-extracted from the template (product name, launch date, audience description) and rendered as a form so non-technical users customize without prompt-engineering.",
      "Optional style controls at generation time (length, formality) shape the whole sequence before you ever open it.",
      "A full multi-email sequence comes back as a single structured object — every email named, subjected, and scored — ready to drop into campaigns.",
      `Generate in the app. The repository MCP catalogue contains a sequence adapter candidate, but ${MCP_RELEASE_HOLD_CODE} means no published/hosted MCP path or cross-surface parity is promised.`,
    ],
    shots: [
      {
        alt: "Template picker — filterable grid of 50 sequence templates across 13 categories",
        variant: "voice",
      },
      {
        alt: "Auto-extracted variable form for a product-launch template: product name, launch date, audience",
        variant: "voice",
      },
      {
        alt: "Generated seven-email welcome sequence with per-email subjects and fidelity badges",
        variant: "voice",
      },
    ],
  },
  {
    id: "fidelity",
    number: "3.0",
    eyebrow: "Fidelity score",
    title: "A number for how much it sounds like you.",
    subhead:
      "Every email is scored 0–100 against your voice profile. The bad ones are regenerated before you see them, so the editor only shows you drafts worth reading.",
    bullets: [
      "Per-email voice-fidelity score: embedding cosine similarity + stylistic-feature distance + vocabulary alignment + structural fit, returned as a 0–100 score with a sub-score breakdown.",
      "Generations under 60 are auto-flagged for regeneration before you see them — you don't get handed the off-voice outputs.",
      "The score renders next to each email in the sequence editor, so you can see at a glance which positions are strongest in your voice.",
      "The sub-score breakdown tells you why a draft is off — vocabulary drift versus structure versus tone — instead of an opaque thumbs-down.",
      "The same scoring runs whether you generated a whole sequence or regenerated a single email, so a hinted rewrite is held to the same bar.",
      "The app applies the same score threshold when it offers regeneration. MCP source definitions are not a callable or parity-qualified path while the distribution hold is active.",
    ],
    shots: [
      {
        alt: "Sequence editor showing per-email fidelity scores with a sub-score breakdown popover",
        variant: "voice",
      },
      {
        alt: "Auto-regeneration notice: a draft scored below 60 was regenerated before reaching the editor",
        variant: "voice",
      },
      {
        alt: "Fidelity sub-scores: embedding similarity, stylistic distance, vocabulary alignment, structural fit",
        variant: "voice",
      },
    ],
  },
  {
    id: "editing",
    number: "4.0",
    eyebrow: "Editing",
    title: "Nudge one email without losing the rest.",
    subhead:
      "Regenerate one position with a hint and four sliders, review the candidate, then explicitly accept it. Every other email stays untouched.",
    bullets: [
      "Per-email regenerate with a hint textarea ('shorter', 'more direct opening') so you steer the rewrite in plain language.",
      "Four style sliders on every regenerate: humor, directness, length, and formality. Dial in the register without rewriting the prompt.",
      "The rewrite is a non-persisting preview until you accept it; versioned acceptance refuses to overwrite a newer sequence edit.",
      "Regenerated emails are re-scored against your profile, so a nudge can't quietly drift off-voice — it's held to the same fidelity bar as the first pass.",
      "Subject-line guardrails carry through: if a variant drops a merge tag the anchor had (so it would send 'Hi , …'), it's rejected rather than shipped.",
      "Hints and slider settings travel through the in-app generation path. No identical MCP rewrite behavior is claimed while that distribution remains release-held.",
    ],
    shots: [
      {
        alt: "Per-email regenerate panel with a hint textarea and four sliders: humor, directness, length, formality",
        variant: "voice",
      },
      {
        alt: "Before-and-after review for one regenerated email before versioned acceptance",
        variant: "voice",
      },
      {
        alt: "Regenerated email re-scored against the voice profile with an updated fidelity badge",
        variant: "voice",
      },
    ],
  },
  {
    id: "beyond-sequences",
    number: "5.0",
    eyebrow: "Beyond sequences",
    title: "The same voice layer, everywhere copy gets written.",
    subhead:
      "Sequences are the headline, but the voice layer is wired into the rest of the app — subject lines, broadcasts, segments, microcopy — so on-brand isn't a separate workflow.",
    bullets: [
      "AI subject-line generation: a plain-English brief in, distinct candidates out (default 3, up to 5), plus a 90-day top-performers panel drawn from your own sent campaigns for inspiration.",
      "AI compose: a one-line brief becomes an A/B-ready broadcast — primary draft plus alternate subject variants — fanned out in parallel and merged into one response.",
      "Brand-voice synthesis: descriptors, writing rules, and sample snippets are injected into context so on-brand microcopy across the app reads like one writer.",
      "AI segment compiler: natural language to a validated segment AST, with strict allow-list validation — every predicate must exist in the registry, every time-window must parse — and a nutrition-facts explainer of what it inferred.",
      "Content optimizer: a deterministic, preview-only multi-arm allocation across subject/body combinations. The preview is not persisted or applied by send workers.",
      "Subject analyzer: correlates subject attributes (length, emoji, question, personalization, all-caps) with engagement on your own list, so guidance comes from your data — not generic benchmarks.",
    ],
    shots: [
      {
        alt: "AI subject-line assistant: brief input, generated candidates, and a 90-day top-performers panel",
        variant: "voice",
      },
      {
        alt: "AI segment compiler turning a natural-language description into a validated segment with a nutrition-facts explainer",
        variant: "audiences",
      },
      {
        alt: "Subject analyzer correlating subject attributes with the tenant's own open and click rates",
        variant: "analytics",
      },
    ],
  },
  {
    id: "privacy",
    number: "6.0",
    eyebrow: "Privacy",
    title: "Your writing trains your profile. Nothing else.",
    subhead:
      "Voice profiles stay inside your workspace, and AI calls route through a PII gateway so personal data in a prompt doesn't reach the model in the clear.",
    bullets: [
      "We never train models on your subscriber data or your generated content. The profile exists to write like you — not to improve a shared model.",
      "Voice profiles stay scoped to your workspace. Your voice isn't pooled across tenants or surfaced to anyone else's generations.",
      "Every AI call routes through a per-request, tenant-scoped PII gateway: configured sensitive values are tokenized before the model sees them and restored in the response.",
      "The gateway is fail-safe — a tenant with nothing marked sensitive is a transparent pass-through, so privacy wiring can't silently break a generation.",
      "Sensitive-value tokenization is per-tenant configuration, so what counts as protected is yours to define, not a one-size default.",
      "The privacy boundary applies across every voice surface — sequences, subject lines, compose — not just the headline feature.",
    ],
    shots: [
      {
        alt: "PII gateway diagram: sensitive values tokenized before the model call, restored in the response",
        variant: "voice",
      },
      {
        alt: "Per-tenant sensitive-value configuration for the AI privacy gateway",
        variant: "developers",
      },
      {
        alt: "Workspace-scoped voice profile settings showing no cross-tenant sharing",
        variant: "voice",
      },
    ],
  },
];

export default function VoicePage(): JSX.Element {
  return (
    <div>
      <JsonLd data={[PRODUCT_JSON_LD, BREADCRUMBS, faqPageSchema(FAQ)]} />
      {/* Hero */}
      <section className="bg-pw-ink text-white">
        <div className="max-w-6xl mx-auto px-6 py-20 md:py-28">
          <h1 className="text-4xl md:text-6xl font-semibold tracking-tight leading-tight max-w-4xl">
            Sequences in your voice. Not chatbot voice.
          </h1>
          <p className="mt-5 text-lg md:text-xl text-pw-muted-on-ink max-w-2xl">
            Train once on what you’ve already written. Pick a template. Get a
            sequence that reads like you wrote it — with a per-email fidelity
            score that flags anything that doesn’t.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/pricing"
              className="inline-flex items-center justify-center rounded-md bg-pw-ember-500 px-5 py-3 text-sm font-medium text-pw-paper shadow-[0_2px_0_0_#7A081B] transition-colors hover:bg-pw-ember-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-700 focus-visible:ring-offset-2"
            >
              View pricing
            </Link>
            <Link
              href="/features"
              className="inline-flex items-center justify-center rounded-md border border-pw-line/30 px-5 py-3 text-sm font-medium text-pw-paper transition-colors hover:border-pw-line/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500"
            >
              See features
            </Link>
          </div>
        </div>
      </section>

      <div className="max-w-6xl mx-auto px-6">
        {SECTIONS.map((s) => (
          <section
            key={s.id}
            id={s.id}
            className="py-24 md:py-32 border-b border-pw-ink2/10 scroll-mt-20"
          >
            <div className="flex items-baseline gap-3 mb-6">
              <span className="font-mono text-sm text-pw-ember-600 tabular-nums">
                {s.number}
              </span>
              <span className="text-xs uppercase tracking-[0.18em] text-pw-muted-on-paper">
                {s.eyebrow}
              </span>
            </div>
            <h2 className="text-3xl md:text-5xl font-semibold tracking-tight text-pw-ink2 leading-tight max-w-3xl">
              {s.title}
            </h2>
            <p className="mt-5 text-base md:text-lg text-pw-muted-on-paper max-w-3xl leading-relaxed">
              {s.subhead}
            </p>

            <ul className="mt-10 grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-3 text-sm text-pw-ink2/80">
              {s.bullets.map((b) => (
                <li key={b} className="flex gap-2 items-start">
                  <span aria-hidden className="text-pw-ember-600 leading-6">
                    ✓
                  </span>
                  <span className="leading-relaxed">{b}</span>
                </li>
              ))}
            </ul>

            <div className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-4">
              {s.shots.map((shot, i) => (
                <ProductShot
                  key={shot.alt}
                  alt={shot.alt}
                  variant={shot.variant}
                  view={(["trend", "list", "grid"] as const)[i % 3]}
                />
              ))}
            </div>
          </section>
        ))}

        {/* FAQ */}
        <section
          aria-labelledby="faq-heading"
          className="py-20 border-t border-pw-ink2/10"
        >
          <h2
            id="faq-heading"
            className="text-2xl md:text-3xl font-semibold tracking-tight text-pw-ink2"
          >
            Frequently asked about Voice AI
          </h2>
          <div className="mt-8 space-y-3">
            {FAQ.map((item) => (
              <details
                key={item.question}
                className="group rounded-lg border border-pw-ink2/10 bg-pw-paper px-5 py-4 [&_summary::-webkit-details-marker]:hidden"
              >
                <summary className="flex cursor-pointer items-start justify-between gap-4 list-none">
                  <h3 className="text-sm font-medium text-pw-ink2">
                    {item.question}
                  </h3>
                  <span
                    aria-hidden
                    className="font-mono text-pw-muted-on-paper/70 text-sm shrink-0 group-open:rotate-45 transition-transform motion-reduce:transition-none"
                  >
                    +
                  </span>
                </summary>
                <p className="mt-3 text-sm text-pw-muted-on-paper leading-relaxed">
                  {item.answer}
                </p>
              </details>
            ))}
          </div>
        </section>

        {/* Closer CTA */}
        <section className="text-center border-t border-pw-ink2/10 py-20">
          <h2 className="text-2xl md:text-3xl font-semibold tracking-tight text-pw-ink2">
            Train your voice. Generate a sequence. Score it.
          </h2>
          <p className="mt-3 text-pw-muted-on-paper max-w-xl mx-auto">
            Bring sample writing, pick a template, and inspect the resulting
            draft and fidelity evidence in an approved sandbox. This page does
            not promise production availability or refund rights.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Link
              href="/features#voice-ai"
              className="inline-flex items-center justify-center rounded-md bg-pw-ember-500 hover:bg-pw-ember-600 shadow-[0_2px_0_0_#7A081B] transition-colors text-white px-5 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-700 focus-visible:ring-offset-2"
            >
              See it in the product →
            </Link>
            <Link
              href="/pricing"
              className="inline-flex items-center justify-center rounded-md border border-pw-ink2/20 hover:border-pw-ink2/40 transition-colors text-pw-ink2 px-5 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-500 focus-visible:ring-offset-2"
            >
              View pricing
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}
