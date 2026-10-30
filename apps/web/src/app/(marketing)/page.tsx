// SPDX-License-Identifier: AGPL-3.0-only
import Link from "next/link";

// WEBJS-003: the eight `@/components/motion/*` wrappers each import
// motion/react, which put a 112 KiB (37 KiB gz) layout-projection engine in
// this route's initial chunk — on the LCP-gated public homepage, 410 bytes
// short of its own bundle budget. These are the same components expressed in
// CSS: same props, same motion, no runtime, and no client boundary at all.
import {
  FadeRise,
  MarqueeRule,
  MotionLink,
  PillarNumber,
  PulseOpacity,
  Stagger,
  StaggerItem,
  TiltIn,
} from "@/components/marketing/reveal";
import {
  MCP_RELEASE_HOLD_CODE,
  MCP_SOURCE_CANDIDATE_LABEL,
} from "@/lib/mcp-release-status";
import { pageMetadata } from "@/lib/marketing-metadata";
import {
  SMS_RELEASE_HOLD_CODES,
  SMS_RELEASE_VERDICT,
} from "@/lib/sms-release-status";
import { TIERS } from "@/lib/pricing";
import { asRoute } from "@/lib/typed-routes";
import { cn } from "@/lib/utils";

export const metadata = pageMetadata({
  title: "Evidence-first newsletter migration",
  description:
    "Move newsletter data with a dry-run report, qualify inbox placement, and draft in your own voice with explicit release evidence.",
  path: "/",
});

interface Pillar {
  number: string;
  id: string;
  eyebrow: string;
  heading: string;
  body: string;
  cta: { href: string; label: string };
  screenshot: { alt: string; caption: string };
  copyOnLeft: boolean;
}

const PILLARS: Pillar[] = [
  {
    number: "1.0",
    id: "migrate",
    eyebrow: "Migrate",
    heading: "Dry-run first. Cut over with proof.",
    body: "ActiveCampaign, HubSpot, Mailchimp, Substack, Beehiiv, ConvertKit, Brevo, MailerLite, or CSV. Source-proven consent evidence is preserved where available; unknowns stay unconfirmed. Tags. Segments. Runtime automations are translated only where the source format is safe; ActiveCampaign, Beehiiv, and MailerLite automation definitions remain rebuild evidence, and HubSpot stays the CRM system of record while contacts and list-membership tags bridge into Moosewave. Stripe-backed subscriptions are preserved only on source-bound supported paths; Substack and Beehiiv contribute premium metadata, not live billing objects. Verification report and 7-day rollback if anything looks off.",
    cta: { href: "/features#migration", label: "See migration in detail" },
    screenshot: {
      alt: "Moosewave migration wizard, dry-run verification report",
      caption: "Dry-run verification report",
    },
    copyOnLeft: true,
  },
  {
    number: "2.0",
    id: "inbox-reality",
    eyebrow: "Inbox Reality",
    heading: "Stop wondering. Know.",
    body: "When controlled inbox testing is enabled, Inbox Reality reports placement from the deployment's active seed roster. Domain reputation. SPF, DKIM, DMARC, BIMI checks. An AI diagnostician explains in plain English what's broken and gives you a one-click fix. Predict placement before you send.",
    cta: {
      href: "/features#deliverability",
      label: "See deliverability in detail",
    },
    screenshot: {
      alt: "Inbox Reality dashboard showing controlled-inbox placement",
      caption: "Seedlist placement report",
    },
    copyOnLeft: false,
  },
  {
    number: "3.0",
    id: "voice-ai",
    eyebrow: "Voice AI",
    heading: "Sound like yourself, not a robot.",
    body: "Train once on your existing writing, past newsletters, Twitter, blog. Pick from 50 proven sequence templates: welcome, course launch, re-engagement, and more. We rewrite them in your actual voice with a fidelity score per email. Regenerate any email with a hint or a style nudge.",
    cta: { href: "/features#voice-ai", label: "See Voice AI in detail" },
    screenshot: {
      alt: "Voice AI sequence editor with per-email fidelity scores",
      caption: "Voice fidelity workspace",
    },
    copyOnLeft: true,
  },
];

interface PlatformCard {
  href: string;
  title: string;
  body: string;
}

// The platform around the three pillars. Every card links to a dedicated,
// shipped capability page.
const PLATFORM: PlatformCard[] = [
  {
    href: "/audiences",
    title: "Audiences & ad sync",
    body: "Consent-gated Meta audience sync, dynamic segments, identity aliases, cohorts, and historical referral reporting. Referral operations remain held.",
  },
  {
    href: "/automations",
    title: "Flow configuration",
    body: "Author and validate typed flow definitions with triggers, branches, and waits. Enrollment, scheduling, execution, and delivery remain release-held.",
  },
  {
    href: "/commerce",
    title: "Commerce",
    body: "Commerce-source evidence, conversion history, revenue reporting, and paid-subscription history. Checkout, billing mutation, and subscription management are unavailable.",
  },
  {
    href: "/sms",
    title: `SMS source surfaces — ${SMS_RELEASE_VERDICT}`,
    body: `Bounded inbox, draft, consent, and suppression presentation exists; hosted SMS dispatch and A2P/provider effects are held (${SMS_RELEASE_HOLD_CODES.reply}, ${SMS_RELEASE_HOLD_CODES.a2p}).`,
  },
  {
    href: "/forms",
    title: "Forms",
    body: "Multi-step embeddable signup forms with double opt-in, custom fields, and five embed flavors.",
  },
  {
    href: "/landing-pages",
    title: "Landing pages",
    body: "Create landing-page records and reserve slugs; hosted forms handle live capture while the full editor is staged.",
  },
  {
    href: "/analytics",
    title: "Analytics & goals",
    body: "Device, geography, and link reports. Side-by-side campaign comparison. Goals with live pacing.",
  },
  {
    href: "/developers",
    title: "Developer platform",
    body: `A marketplace, scoped API keys, and signed webhooks. MCP is a ${MCP_SOURCE_CANDIDATE_LABEL}; ${MCP_RELEASE_HOLD_CODE}.`,
  },
  {
    href: "/podcasts",
    title: "Private podcasts",
    body: "Per-subscriber tokenized RSS with tier-gated episodes and Spotify Open Access for paid feeds.",
  },
];

const MIGRATION_LINKS: { href: string; label: string }[] = [
  { href: "/migrations/activecampaign", label: "ActiveCampaign" },
  { href: "/migrations/hubspot", label: "HubSpot" },
  { href: "/migrations/mailchimp", label: "Mailchimp" },
  { href: "/migrations/convertkit", label: "Kit" },
  { href: "/migrations/mailerlite", label: "MailerLite" },
  { href: "/migrations/sendy", label: "Sendy" },
];

function ProductPreview({
  alt,
  caption,
}: {
  alt: string;
  caption: string;
}): JSX.Element {
  return (
    <div
      role="img"
      aria-label={alt}
      className="mw-cut-paper aspect-video w-full border border-mw-ink/20 bg-mw-pink p-4"
      style={{ boxShadow: "3px 4px 0 rgb(32 32 30 / 0.92)" }}
    >
      <div className="mw-cut-paper flex h-full flex-col justify-between border border-mw-ink/20 bg-mw-paper p-4">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ background: "var(--mw-red)" }}
            />
            <span className="h-2.5 w-20 rounded-full bg-pw-ink2/20" />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <span className="h-16 rounded-xl bg-mw-yellow" />
            <span className="h-16 rounded-xl bg-mw-pink-soft" />
            <span className="h-16 rounded-xl bg-info-subtle" />
          </div>
          <div className="space-y-2">
            <span className="block h-2 rounded bg-pw-ink2/20" />
            <span className="block h-2 w-4/5 rounded bg-pw-ink2/15" />
            <span className="block h-2 w-3/5 rounded bg-pw-ink2/10" />
          </div>
        </div>
        <div className="text-[11px] font-mono uppercase tracking-wider text-pw-muted-on-paper">
          {caption}
        </div>
      </div>
    </div>
  );
}

/** Code-native hero artwork: the reference site's collage language without a
 * route-blocking image download. It stays decorative and collapses cleanly on
 * narrow screens. */
function HeroMailArtwork(): JSX.Element {
  return (
    <div
      aria-hidden="true"
      className="relative mx-auto w-full"
      style={{ aspectRatio: 1, maxWidth: "35rem" }}
    >
      <div
        className="absolute"
        style={{
          inset: "8% 3% 5% 8%",
          borderRadius: "42% 58% 46% 54% / 38% 42% 58% 62%",
          background: "var(--mw-yellow)",
          transform: "rotate(3deg)",
        }}
      />
      <div
        className="absolute overflow-hidden"
        style={{
          inset: "2% 8% 10% 2%",
          border: "2px solid var(--mw-ink)",
          borderRadius: "48% 52% 44% 56% / 40% 35% 65% 60%",
          background: "var(--mw-pink)",
          boxShadow: "8px 9px 0 var(--mw-ink)",
          transform: "rotate(-3deg)",
        }}
      >
        <div
          className="absolute inset-0"
          style={{
            background:
              "repeating-linear-gradient(145deg, var(--mw-ink) 0 2px, transparent 2px 17px)",
            opacity: 0.2,
          }}
        />
        <div
          className="absolute"
          style={{
            bottom: "1.25rem",
            left: "-4rem",
            width: "130%",
            height: "11rem",
            background: "var(--mw-blue)",
            transform: "rotate(-12deg)",
          }}
        />
        <div
          className="absolute"
          style={{
            top: "4rem",
            right: "-4rem",
            width: "13rem",
            height: "13rem",
            background: "var(--mw-red)",
            clipPath:
              "polygon(50% 0%, 61% 34%, 98% 23%, 69% 53%, 96% 77%, 60% 68%, 50% 100%, 39% 67%, 4% 79%, 31% 52%, 3% 26%, 39% 34%)",
            transform: "rotate(12deg)",
          }}
        />
      </div>

      <div
        className="absolute p-5 sm:p-8"
        style={{
          top: "32%",
          left: "12%",
          width: "72%",
          border: "2px solid var(--mw-ink)",
          background: "var(--mw-paper)",
          boxShadow: "7px 8px 0 var(--mw-ink)",
          transform: "rotate(-6deg)",
        }}
      >
        <svg viewBox="0 0 320 190" className="w-full" fill="none">
          <path
            d="M7 20h306v163H7z"
            fill="#fffbee"
            stroke="#20201e"
            strokeWidth="7"
          />
          <path
            d="m10 24 149 99L310 24"
            stroke="#20201e"
            strokeWidth="8"
            strokeLinejoin="round"
          />
          <path
            d="m10 179 105-88m195 88-105-88"
            stroke="#20201e"
            strokeWidth="7"
          />
          <path
            d="M50 49c34-15 73-16 109-2"
            stroke="#244cad"
            strokeWidth="5"
            strokeLinecap="round"
          />
        </svg>
      </div>

      <div
        className="mw-cut-paper absolute right-0 px-5 py-3 text-center"
        style={{
          top: "9%",
          maxWidth: "17rem",
          border: "2px solid var(--mw-ink)",
          background: "var(--mw-paper)",
          boxShadow: "4px 5px 0 var(--mw-ink)",
          transform: "rotate(3deg)",
        }}
      >
        <span className="font-display text-xl uppercase leading-none text-mw-ink sm:text-3xl">
          Good ideas deserve
        </span>{" "}
        <span className="block font-hand text-2xl leading-none text-mw-blue sm:text-4xl">
          a good send.
        </span>
      </div>
      <p
        className="absolute bottom-0 font-hand text-2xl text-mw-blue sm:text-3xl"
        style={{ left: "11%", transform: "rotate(-2deg)" }}
      >
        Your voice. Your proof.
      </p>
    </div>
  );
}

export default function MarketingHomePage(): JSX.Element {
  return (
    <div className="bg-mw-paper">
      {/* === Section 1: Hero === */}
      <section
        data-tour="marketing-hero"
        className="relative overflow-hidden bg-mw-paper text-mw-ink"
        style={{
          backgroundImage:
            "radial-gradient(circle, var(--mw-paper-grid) 0 1px, transparent 1.2px)",
          backgroundSize: "18px 18px",
        }}
      >
        <div className="mx-auto max-w-7xl px-5 pb-20 pt-14 sm:px-8">
          <div className="grid items-center gap-14 lg:grid-cols-2">
            <div className="max-w-2xl">
              <p className="mb-6 font-hand text-xl text-mw-blue sm:text-2xl">
                Email marketing, migration, and delivery · Meet Moosewave
              </p>
              {/* The primary paint stays outside the motion client boundary so
                it is immediately available from the server-rendered HTML. */}
              <h1
                className="mw-display text-mw-ink"
                style={{ fontSize: "clamp(4rem, 9vw, 8.5rem)" }}
              >
                A newsletter platform being qualified with evidence.
              </h1>
              <Stagger
                scrollTrigger={false}
                delayChildren={0}
                staggerChildren={0.08}
              >
                <StaggerItem>
                  <p
                    className="mt-5 inline-block font-hand leading-none text-mw-blue"
                    style={{
                      fontSize: "clamp(2rem, 4vw, 3.75rem)",
                      backgroundImage:
                        "linear-gradient(transparent 72%, var(--mw-yellow) 72% 92%, transparent 92%)",
                    }}
                  >
                    Move with proof. Land in inbox. Sound like yourself.
                  </p>
                </StaggerItem>

                <StaggerItem>
                  <div className="mt-10 flex flex-wrap items-center gap-4">
                    <Link
                      href="/migrations"
                      className="mw-cut-paper mw-tactile inline-flex min-h-12 items-center bg-mw-yellow px-6 text-sm font-bold text-mw-ink"
                    >
                      Review migration paths{" "}
                      <span aria-hidden className="ml-4">
                        →
                      </span>
                    </Link>
                    <Link
                      href="#how-it-works"
                      className="mw-scribble-link inline-flex min-h-11 items-center px-2 text-sm font-semibold text-mw-ink"
                    >
                      See how qualification works{" "}
                      <span aria-hidden className="ml-3">
                        ↓
                      </span>
                    </Link>
                  </div>
                </StaggerItem>

                <StaggerItem>
                  <div className="mt-6">
                    <Link
                      href="/mcp"
                      className="inline-flex items-center gap-2 rounded-full border border-mw-ink/20 bg-mw-paper px-3 py-1 font-mono text-xs text-pw-muted-on-paper transition-colors hover:border-mw-blue hover:text-mw-blue"
                    >
                      <span
                        className="inline-block h-1.5 w-1.5 rounded-full"
                        style={{ background: "var(--mw-red)" }}
                      />
                      MCP source candidate · release held
                      <span aria-hidden>→</span>
                    </Link>
                  </div>
                </StaggerItem>
              </Stagger>
            </div>
            <HeroMailArtwork />
          </div>

          <Stagger scrollTrigger={false} className="mt-16">
            {/* Trust stripe */}
            <StaggerItem>
              <div className="grid grid-cols-1 border-y border-mw-ink/20 md:grid-cols-3 md:divide-x">
                <div className="py-6 md:px-8 md:first:pl-0">
                  <div className="font-hand text-lg text-mw-blue">
                    Built on Listmonk
                  </div>
                  <div className="mt-2 text-sm leading-relaxed text-pw-muted-on-paper">
                    Upstream Listmonk runs as a separate HTTP service. Its
                    production image and deployment still require immutable
                    release evidence.
                  </div>
                </div>
                <div className="py-6 md:px-8">
                  <div className="font-hand text-lg text-mw-blue">
                    Sender flexibility
                  </div>
                  <div className="mt-2 text-sm leading-relaxed text-pw-muted-on-paper">
                    BYO-provider paths are implemented. Managed sending stays
                    gated until provider, capacity, billing, and deliverability
                    rehearsals pass.
                  </div>
                </div>
                <div className="py-6 md:px-8 md:last:pr-0">
                  <div className="font-hand text-lg text-mw-blue">License</div>
                  <div className="mt-2 text-sm leading-relaxed text-pw-muted-on-paper">
                    Moosewave application code is AGPL-3.0; reusable SDK, CLI,
                    MCP, and component packages are MIT. Brand assets remain
                    separately licensed.
                  </div>
                </div>
              </div>
            </StaggerItem>

            <StaggerItem>
              <PulseOpacity className="mt-10 pt-2">
                <div className="font-hand text-lg text-mw-blue">
                  Migrates from the tools creators already use
                </div>
                <div className="mt-4 grid grid-cols-2 sm:grid-cols-5 gap-6">
                  {[
                    "ActiveCampaign",
                    "HubSpot",
                    "Mailchimp",
                    "Substack",
                    "Beehiiv",
                    "ConvertKit",
                    "Brevo",
                    "MailerLite",
                  ].map((name) => (
                    <div
                      key={name}
                      className="mw-cut-paper flex h-9 items-center justify-center border border-mw-ink/20 bg-mw-paper text-[11px] font-mono text-pw-muted-on-paper"
                    >
                      {name}
                    </div>
                  ))}
                </div>
              </PulseOpacity>
            </StaggerItem>
          </Stagger>
        </div>
      </section>

      {/* === Section 2: Three pillars === */}
      <section id="how-it-works" className="bg-mw-paper">
        <div className="max-w-6xl mx-auto px-6 pt-24 md:pt-32 pb-12">
          <FadeRise className="max-w-3xl">
            <MarqueeRule className="h-[2px] w-16 mb-5 origin-left" />
            <div className="font-hand text-xl text-mw-blue">How it works</div>
            <h2 className="mw-display mt-3 text-5xl text-mw-ink md:text-7xl">
              Three things, done properly.
            </h2>
            <p className="mt-4 text-base md:text-lg text-pw-muted-on-paper">
              The three hard problems most platforms fumble. The rest of the
              platform is here too, with explicit export and source-license
              boundaries.
            </p>
          </FadeRise>
        </div>

        {PILLARS.map((p) => (
          <div
            key={p.id}
            id={p.id}
            data-tour={
              p.id === "migrate"
                ? "marketing-pillar-migrate"
                : p.id === "inbox-reality"
                  ? "marketing-pillar-inbox"
                  : p.id === "voice-ai"
                    ? "marketing-pillar-voice"
                    : undefined
            }
            className={cn(
              "scroll-mt-20 border-t border-mw-ink/20",
              p.id === "migrate" && "bg-mw-yellow",
              p.id === "inbox-reality" && "bg-mw-paper",
              p.id === "voice-ai" && "bg-mw-pink",
            )}
          >
            <div className="max-w-6xl mx-auto px-6 py-24 md:py-32 grid md:grid-cols-2 gap-12 md:gap-16 items-center">
              <FadeRise
                className={cn(p.copyOnLeft ? "md:order-1" : "md:order-2")}
              >
                <div className="flex items-baseline gap-3 mb-6">
                  <PillarNumber className="font-mono text-3xl md:text-4xl text-pw-ember-600 tabular-nums font-semibold inline-block">
                    {p.number}
                  </PillarNumber>
                  <span className="font-hand text-lg text-mw-blue">
                    {p.eyebrow}
                  </span>
                </div>
                <h3 className="mw-display text-4xl text-mw-ink md:text-6xl">
                  {p.heading}
                </h3>
                <p className="mt-5 text-pw-muted-on-paper leading-relaxed">
                  {p.body}
                </p>
                <div className="mt-7">
                  <Link
                    href={asRoute(p.cta.href)}
                    className="mw-scribble-link inline-flex items-center text-sm font-semibold text-mw-blue"
                  >
                    {p.cta.label} →
                  </Link>
                </div>
              </FadeRise>
              <TiltIn
                className={cn(p.copyOnLeft ? "md:order-2" : "md:order-1")}
              >
                <ProductPreview
                  alt={p.screenshot.alt}
                  caption={p.screenshot.caption}
                />
              </TiltIn>
            </div>
          </div>
        ))}
      </section>

      {/* === Section 2.5: The whole platform === */}
      <section className="border-t border-mw-ink/20 bg-mw-pink">
        <div className="max-w-6xl mx-auto px-6 py-24 md:py-32">
          <FadeRise className="max-w-3xl">
            <MarqueeRule className="h-[2px] w-16 mb-5 origin-left" />
            <div className="font-hand text-xl text-mw-blue">The platform</div>
            <h2 className="mw-display mt-3 text-5xl text-mw-ink md:text-7xl">
              Then the rest of the platform. Built just as properly.
            </h2>
            <p className="mt-4 text-base md:text-lg text-pw-muted-on-paper">
              Migration, deliverability, and voice are the hard parts. Around
              them is everything a modern newsletter business runs on — ad
              audiences, commerce, SMS, automations, a developer platform — and
              each release catalog states exactly which ones are available.
            </p>
          </FadeRise>

          <Stagger className="mt-12 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {PLATFORM.map((card) => (
              <StaggerItem key={card.href}>
                <Link
                  href={asRoute(card.href)}
                  className="mw-cut-paper mw-tactile group block h-full border-mw-ink/20 bg-mw-paper p-5"
                >
                  <h3 className="font-display text-xl font-normal uppercase leading-none text-mw-ink transition-colors group-hover:text-mw-blue">
                    {card.title}
                  </h3>
                  <p className="mt-2 text-sm text-pw-muted-on-paper leading-relaxed">
                    {card.body}
                  </p>
                </Link>
              </StaggerItem>
            ))}
          </Stagger>

          <FadeRise className="mt-10">
            <Link
              href="/features"
              className="mw-scribble-link inline-flex items-center text-sm font-semibold text-mw-blue"
            >
              See the whole platform →
            </Link>
          </FadeRise>
        </div>
      </section>

      {/* === Section 3: Pricing teaser === */}
      <section
        data-tour="marketing-pricing"
        className="border-t border-mw-ink/20 bg-mw-yellow"
        style={{
          borderRadius: "0 0 1.5rem 1.5rem",
          backgroundImage:
            "radial-gradient(circle, var(--mw-paper-grid) 0 1px, transparent 1.2px)",
          backgroundSize: "18px 18px",
        }}
      >
        <div className="max-w-6xl mx-auto px-6 py-24 md:py-32">
          <FadeRise className="max-w-3xl">
            <MarqueeRule className="h-[2px] w-16 mb-5 origin-left" />
            <div className="font-hand text-xl text-mw-blue">Pricing</div>
            <h2 className="mw-display mt-3 text-5xl text-mw-ink md:text-7xl">
              A provisional catalog, not an open checkout.
            </h2>
            <p className="mt-4 text-base md:text-lg text-pw-muted-on-paper">
              Proposed prices remain subject to commercial, legal, provider,
              capacity, tax, and live-payment approval.
            </p>
          </FadeRise>

          <Stagger className="mt-12 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
            {TIERS.map((t, i) => {
              const isFeatured = i === 2;
              return (
                <StaggerItem
                  key={t.tier}
                  className={cn(
                    "mw-cut-paper flex flex-col border bg-mw-paper p-6",
                    isFeatured ? "border-mw-blue" : "border-mw-ink/20",
                  )}
                  style={{ boxShadow: "2px 3px 0 rgb(32 32 30 / 0.82)" }}
                >
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold text-pw-ink2">
                      {t.name}
                    </div>
                    {isFeatured ? (
                      <span className="shrink-0 -rotate-2 rounded bg-mw-pink px-2 py-0.5 font-hand text-sm text-mw-ink">
                        Proposed
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-4 flex items-baseline gap-2">
                    <span className="text-3xl font-semibold tracking-tight text-pw-ink2">
                      {t.price}
                    </span>
                    <span className="text-xs text-pw-muted-on-paper">
                      {t.cadence === "free"
                        ? "free"
                        : t.cadence === "monthly"
                          ? "/ month"
                          : "once"}
                    </span>
                  </div>
                  {t.perEmail !== null ? (
                    <div className="mt-1 text-xs font-mono text-pw-ink2/70">
                      + {t.perEmail} sent
                    </div>
                  ) : (
                    <div className="mt-1 text-xs font-mono text-pw-muted-on-paper">
                      no automatic paid overage
                    </div>
                  )}
                  <p className="mt-3 text-sm text-pw-muted-on-paper">
                    {t.tagline}
                  </p>
                  <ul className="mt-5 space-y-2 text-sm text-pw-ink2/80 flex-1">
                    {t.features
                      .filter((f) => f.included)
                      .slice(0, 4)
                      .map((f) => (
                        <li key={f.label} className="flex gap-2 items-start">
                          <span aria-hidden className="leading-6 text-mw-blue">
                            ✓
                          </span>
                          <span>{f.label}</span>
                        </li>
                      ))}
                  </ul>
                  <div className="mt-6 pt-5 border-t border-pw-surface">
                    <Link
                      href="/pricing"
                      className="mw-scribble-link text-sm font-semibold text-mw-blue"
                    >
                      View full pricing →
                    </Link>
                  </div>
                </StaggerItem>
              );
            })}
          </Stagger>

          <FadeRise className="mt-10">
            <Link
              href="/pricing"
              className="mw-scribble-link inline-flex items-center text-sm font-semibold text-mw-blue"
            >
              Compare in detail →
            </Link>
          </FadeRise>
        </div>
      </section>

      {/* === Section 4: migration comparisons === */}
      <section className="border-t border-mw-ink/20 bg-mw-paper">
        <div className="max-w-6xl mx-auto px-6 py-24 md:py-32">
          <FadeRise className="max-w-3xl">
            <MarqueeRule className="h-[2px] w-16 mb-5 origin-left" />
            <div className="font-hand text-xl text-mw-blue">
              Compare migration paths
            </div>
            <h2 className="mw-display mt-3 text-5xl text-mw-ink md:text-7xl">
              Review fit before you move.
            </h2>
            <p className="mt-4 text-base md:text-lg text-pw-muted-on-paper">
              Vendor prices and feature sets change. These pages focus on the
              migration evidence, retained data, and trade-offs you can verify
              before purchase.
            </p>
          </FadeRise>

          <Stagger className="mt-10 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
            {MIGRATION_LINKS.map((l) => (
              <StaggerItem key={l.href}>
                <Link
                  href={asRoute(l.href)}
                  className="mw-cut-paper mw-tactile block border-mw-ink/20 bg-mw-paper px-3 py-2 text-center text-sm text-mw-ink"
                >
                  {l.label} →
                </Link>
              </StaggerItem>
            ))}
          </Stagger>
        </div>
      </section>

      {/* === Section 5: Team note + closer === */}
      <section
        className="border-t bg-mw-ink"
        style={{ borderColor: "var(--mw-ink)", color: "var(--mw-paper)" }}
      >
        <div className="max-w-3xl mx-auto px-6 py-24 md:py-32">
          <FadeRise>
            <MarqueeRule className="h-[2px] w-16 mb-5 origin-left" />
            <div className="font-hand text-xl text-mw-yellow">
              From the team
            </div>
            <h2 className="mw-display mt-3 text-5xl md:text-7xl">
              Why we&apos;re building this.
            </h2>
          </FadeRise>
          <Stagger className="mt-10 space-y-6 text-pw-muted-on-ink leading-relaxed text-base md:text-lg">
            <StaggerItem as="p">
              Changing newsletter platforms is hard because customer data,
              consent evidence, automations, sending reputation, and billing
              state all have to move safely. That migration risk deserves
              evidence, not a savings estimate built from another vendor&apos;s
              changing prices.
            </StaggerItem>
            <StaggerItem as="p">
              Moosewave uses upstream Listmonk as a separate email-engine
              service. The product work around it focuses on guided migration,
              deliverability evidence, and voice-assisted drafting. Each part
              remains unavailable to clients until its release and
              provider-backed checks pass.
            </StaggerItem>
            <StaggerItem as="p">
              If you&apos;ve been holding off on switching because the migration
              looks scary, we built Moosewave for you. We&apos;d love to have
              you.
            </StaggerItem>
          </Stagger>
          <FadeRise className="mt-10 flex items-center gap-3" delay={0.2}>
            <span
              aria-hidden
              className="relative inline-block h-4 w-4 rounded-sm bg-white/10"
            >
              <span className="absolute inset-1 rounded-[2px] bg-pw-ember-500" />
            </span>
            <span className="text-sm text-pw-muted-on-ink">
              The Moosewave team
            </span>
          </FadeRise>
        </div>

        <div className="border-t border-white/10" data-tour="marketing-cta">
          <div className="max-w-6xl mx-auto px-6 py-16 flex flex-col md:flex-row md:items-center md:justify-between gap-6">
            <FadeRise className="text-2xl md:text-3xl font-semibold tracking-tight">
              Review the qualification evidence with us.
            </FadeRise>
            <FadeRise className="flex flex-wrap gap-3" delay={0.1}>
              <MotionLink href="/migrations" variant="primary">
                Review migration readiness →
              </MotionLink>
              <MotionLink
                href="/pricing"
                variant="ghost"
                className="border-white/20 text-white hover:border-white/40 hover:bg-white/5"
              >
                View pricing
              </MotionLink>
            </FadeRise>
          </div>
        </div>
      </section>
    </div>
  );
}
