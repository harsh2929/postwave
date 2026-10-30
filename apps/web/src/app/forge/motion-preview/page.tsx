// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
  motion,
  useInView,
  useScroll,
  useSpring,
  useReducedMotion,
  useTransform,
  type MotionValue,
} from "motion/react";
import { useEffect, useRef, useState } from "react";

import { MCP_CATEGORY_COUNT, MCP_TOOL_COUNT } from "@/lib/mcp-catalog-stats";
import {
  AGENT_INTERACTIVE_RELEASE_STATUS_COPY,
  MCP_RELEASE_HOLD_CODE,
  MCP_RELEASE_STATUS_COPY,
} from "@/lib/mcp-release-status";

const SECTIONS = [
  { id: "demo-1", label: "1. Terminal type-on" },
  { id: "demo-2", label: "2. Staggered category reveal" },
  { id: "demo-3", label: "3. Code-block hover pulse" },
  { id: "demo-4", label: "4. Scroll-driven step reveal" },
  { id: "demo-5", label: "5. Sidebar active indicator" },
  { id: "demo-6", label: "6. Stat count-up" },
  { id: "demo-7", label: "7. Pricing tier micro-tilt" },
];

export default function MotionPreviewPage() {
  return (
    <div className="font-sans">
      <section className="border-b border-white/10 bg-pw-ink">
        <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
          <div className="text-xs font-mono uppercase tracking-widest text-pw-ember-300">
            Source-only motion study · release hold active
          </div>
          <h1 className="mt-3 text-3xl md:text-4xl font-semibold tracking-tight">
            Seven motion.dev candidates.
          </h1>
          <p className="mt-3 max-w-2xl text-white/60">
            Each numbered block is a visual source illustration, not a runnable
            agent transcript or shipped capability. {MCP_RELEASE_STATUS_COPY}{" "}
            {AGENT_INTERACTIVE_RELEASE_STATUS_COPY}
          </p>
          <nav
            aria-label="Motion demo sections"
            className="mt-6 flex flex-wrap gap-x-5 gap-y-1"
          >
            {SECTIONS.map((s) => (
              <a
                key={s.id}
                href={`#${s.id}`}
                className="inline-flex min-h-11 items-center font-mono text-xs text-pw-ember-300 hover:text-pw-ember-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-400"
              >
                {s.label}
              </a>
            ))}
          </nav>
        </div>
      </section>

      <Demo1 />
      <Demo2 />
      <Demo3 />
      <Demo4 />
      <Demo5 />
      <Demo6 />
      <Demo7 />

      <section className="border-t border-white/10 py-16">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <p className="font-mono text-xs text-white/50">
            End of preview. Pick which to ship.
          </p>
        </div>
      </section>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Demo 1 — terminal type-on                                              */
/* ---------------------------------------------------------------------- */

const TYPE_LINES = [
  `$ status: ${MCP_RELEASE_HOLD_CODE}`,
  "",
  MCP_RELEASE_STATUS_COPY,
  "",
  `catalog: ${MCP_TOOL_COUNT} mutable source definitions`,
  "setup: unavailable",
];

function Demo1() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.4 });
  return (
    <DemoSection
      id="demo-1"
      title="1. Terminal type-on"
      blurb="Each line types in with 18ms-per-char cascade. Trigger on first scroll into view. Cheap, sets the dev-tool tone immediately."
    >
      <div
        ref={ref}
        tabIndex={0}
        role="group"
        aria-label="Terminal type-on motion example"
        className="min-h-[280px] rounded-lg border border-white/10 bg-black/60 px-5 py-5 font-mono text-sm leading-relaxed text-pw-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-400"
      >
        <span className="sr-only">{TYPE_LINES.join("\n")}</span>
        <div aria-hidden="true">
          {TYPE_LINES.map((line, i) => (
            <TypeLine key={i} line={line} delay={i * 0.35} active={inView} />
          ))}
        </div>
      </div>
    </DemoSection>
  );
}

function TypeLine({
  line,
  delay,
  active,
}: {
  line: string;
  delay: number;
  active: boolean;
}) {
  const [shown, setShown] = useState(0);
  const reduceMotion = useReducedMotion();
  useEffect(() => {
    if (!active) return;
    if (reduceMotion) {
      setShown(line.length);
      return;
    }
    setShown(0);
    let id: ReturnType<typeof setInterval> | null = null;
    const t = setTimeout(() => {
      let i = 0;
      id = setInterval(() => {
        i += 1;
        setShown(i);
        if (i >= line.length && id !== null) clearInterval(id);
      }, 18);
    }, delay * 1000);
    return () => {
      clearTimeout(t);
      if (id !== null) clearInterval(id);
    };
  }, [active, delay, line.length, reduceMotion]);
  return (
    <div className="whitespace-pre">{line.slice(0, shown) || "\u00A0"}</div>
  );
}

/* ---------------------------------------------------------------------- */
/* Demo 2 — staggered category reveal                                     */
/* ---------------------------------------------------------------------- */

const CATEGORIES = [
  { name: "audience", count: 12 },
  { name: "campaigns", count: 13 },
  { name: "analytics", count: 8 },
  { name: "automations", count: 5 },
  { name: "deliverability", count: 7 },
  { name: "platform", count: 12 },
  { name: "billing", count: 8 },
  { name: "domains", count: 4 },
  { name: "archive", count: 3 },
  { name: "referrals", count: 4 },
  { name: "forms", count: 7 },
  { name: "voice", count: 5 },
  { name: "subscribers", count: 11 },
  { name: "topics", count: 5 },
  { name: "templates", count: 2 },
  { name: "agent", count: 6 },
  { name: "admin", count: 10 },
  { name: "events", count: 1 },
  { name: "migration", count: 6 },
];

function Demo2() {
  return (
    <DemoSection
      id="demo-2"
      title="2. Staggered category reveal"
      blurb="The 19-category grid fades in y:14→0 with stagger 0.07s, each child 0.45s ease-out. Total ~1.7s — visible without dragging. Feels like a developer console booting up."
    >
      <motion.div
        role="list"
        aria-label="Source category counts"
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, amount: 0.2 }}
        variants={{
          hidden: {},
          show: { transition: { staggerChildren: 0.07, delayChildren: 0.05 } },
        }}
        className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4"
      >
        {CATEGORIES.map((c) => (
          <motion.div
            key={c.name}
            role="listitem"
            variants={{
              hidden: { opacity: 0, y: 14 },
              show: { opacity: 1, y: 0 },
            }}
            transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
            className="rounded-md border border-white/10 bg-black/30 px-4 py-3 motion-reduce:!translate-y-0 motion-reduce:!opacity-100"
          >
            <div className="flex items-baseline justify-between">
              <div className="font-mono text-sm text-pw-paper">{c.name}</div>
              <div className="font-mono text-[11px] text-pw-ember-300">
                {c.count}
              </div>
            </div>
          </motion.div>
        ))}
      </motion.div>
    </DemoSection>
  );
}

/* ---------------------------------------------------------------------- */
/* Demo 3 — code-block hover pulse                                        */
/* ---------------------------------------------------------------------- */

function Demo3() {
  return (
    <DemoSection
      id="demo-3"
      title="3. Code-block hover pulse"
      blurb="Hover any of the three. Subtle ember box-shadow pulse + language-tag swap. Conveys interactive without faking a real button."
    >
      <div
        role="list"
        aria-label="Code-block motion examples"
        className="grid gap-4 md:grid-cols-3"
      >
        {[
          {
            tag: "Sandbox",
            code: `X-Postwave-Sandbox: true`,
          },
          {
            tag: "Budgets",
            code: `api_key.budget = {\n  sends_per_day: 1000,\n}`,
          },
          {
            tag: "Approvals",
            code: `campaign.create({\n  requires_approval: true,\n})`,
          },
        ].map((p) => (
          <PulseCard key={p.tag} tag={p.tag} code={p.code} />
        ))}
      </div>
    </DemoSection>
  );
}

function PulseCard({ tag, code }: { tag: string; code: string }) {
  const [active, setActive] = useState(false);
  return (
    <motion.div
      role="listitem"
      onHoverStart={() => setActive(true)}
      onHoverEnd={() => setActive(false)}
      onFocusCapture={() => setActive(true)}
      onBlurCapture={() => setActive(false)}
      animate={{
        boxShadow: active
          ? "0 0 0 1px rgba(200, 16, 46, 0.6), 0 0 24px 0 rgba(200, 16, 46, 0.25)"
          : "0 0 0 1px rgba(255,255,255,0.10), 0 0 0 0 rgba(200, 16, 46, 0)",
      }}
      transition={{ duration: 0.4 }}
      className="rounded-lg bg-black/40 p-5"
    >
      <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-white/50">
        <motion.span
          key={active ? "copy" : "primitive"}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.15 }}
        >
          {active ? "copy" : "primitive"}
        </motion.span>
        <span>{tag}</span>
      </div>
      <pre
        tabIndex={0}
        role="group"
        aria-label={`${tag} code motion example`}
        className="mt-4 overflow-x-auto rounded bg-black/60 px-3 py-3 font-mono text-xs text-pw-ember-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <code>{code}</code>
      </pre>
    </motion.div>
  );
}

/* ---------------------------------------------------------------------- */
/* Demo 4 — scroll-driven step reveal                                     */
/* ---------------------------------------------------------------------- */

const LOOP_STEPS = [
  "1. Source-only registry illustration",
  "2. Output review remains open",
  "3. Sandbox guarantees remain open",
  "4. Interactive execution is held",
  "5. Approval coupling is unqualified",
  "6. Distribution remains held",
];

function Demo4() {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start 0.8", "end 0.4"],
  });
  return (
    <DemoSection
      id="demo-4"
      title="4. Scroll-driven step reveal"
      blurb="Scroll slowly. Each source-status step fades in sequentially; this motion study does not depict a working agent execution."
    >
      <div
        ref={ref}
        role="list"
        aria-label="Source status steps"
        className="rounded-lg border border-white/10 bg-black/40 p-8 min-h-[600px] flex flex-col justify-center"
      >
        {LOOP_STEPS.map((step, i) => (
          <ScrollStep
            key={i}
            text={step}
            scrollYProgress={scrollYProgress}
            position={i / (LOOP_STEPS.length - 1)}
          />
        ))}
      </div>
    </DemoSection>
  );
}

function ScrollStep({
  text,
  scrollYProgress,
  position,
}: {
  text: string;
  scrollYProgress: MotionValue<number>;
  position: number;
}) {
  const start = Math.max(0, position - 0.1);
  const end = Math.min(1, position + 0.1);
  const opacity = useTransform(scrollYProgress, [start, end], [0.2, 1]);
  const x = useTransform(scrollYProgress, [start, end], [-12, 0]);
  return (
    <motion.div
      role="listitem"
      style={{ opacity, x }}
      className="py-2 font-mono text-base text-pw-paper motion-reduce:!translate-x-0 motion-reduce:!opacity-100 md:text-lg"
    >
      {text}
    </motion.div>
  );
}

/* ---------------------------------------------------------------------- */
/* Demo 5 — sidebar active indicator                                      */
/* ---------------------------------------------------------------------- */

const DOC_SECTIONS = [
  "Quickstart",
  "Auth",
  "Sandbox",
  "Budgets",
  "Approvals",
  "Agent loop",
  "Tools",
  "Transports",
];

function Demo5() {
  const [active, setActive] = useState(0);
  return (
    <DemoSection
      id="demo-5"
      title="5. Sidebar active indicator"
      blurb="Click a section. The 2px ember bar slides via layoutId. In production the active state is driven by scroll position; here it's click-driven so you can see the slide."
    >
      <div className="grid gap-8 md:grid-cols-[200px_1fr]">
        <div
          role="group"
          aria-label="Documentation sidebar demo"
          className="flex flex-col gap-1.5 border-r border-white/10 pr-4"
        >
          {DOC_SECTIONS.map((s, i) => (
            <button
              key={s}
              type="button"
              onClick={() => setActive(i)}
              aria-pressed={active === i}
              className="relative flex min-h-11 items-center justify-start rounded-sm py-1.5 text-left font-mono text-xs text-white/60 hover:text-pw-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-400"
            >
              {active === i && (
                <motion.div
                  layoutId="demo5-active"
                  className="absolute -left-4 top-0 h-full w-[2px] bg-pw-ember-500"
                  transition={{ type: "spring", stiffness: 380, damping: 30 }}
                />
              )}
              <span className={active === i ? "text-pw-paper" : ""}>{s}</span>
            </button>
          ))}
        </div>
        <div className="rounded-lg border border-white/10 bg-black/30 p-6 font-mono text-xs text-white/50">
          (mock doc body — click sections on the left)
        </div>
      </div>
    </DemoSection>
  );
}

/* ---------------------------------------------------------------------- */
/* Demo 6 — stat count-up                                                 */
/* ---------------------------------------------------------------------- */

function Demo6() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.6 });
  return (
    <DemoSection
      id="demo-6"
      title="6. Stat count-up"
      blurb="Numbers spring from 0 to final on first view. Resend uses this exact trick. Don't apply elsewhere — the surprise is part of why it works."
    >
      <div
        ref={ref}
        className="grid grid-cols-2 gap-6 rounded-lg border border-white/10 bg-black/30 p-8 md:grid-cols-3"
      >
        <CountStat
          value={MCP_TOOL_COUNT}
          label="Source definitions"
          active={inView}
        />
        <CountStat
          value={MCP_CATEGORY_COUNT}
          label="Categories"
          active={inView}
        />
        <CountStat value={6} label="Source concepts held" active={inView} />
      </div>
    </DemoSection>
  );
}

function CountStat({
  value,
  label,
  active,
}: {
  value: number;
  label: string;
  active: boolean;
}) {
  const [n, setN] = useState(0);
  const reduceMotion = useReducedMotion();
  const spring = useSpring(0, { stiffness: 60, damping: 15 });
  useEffect(() => {
    if (!active) return;
    if (reduceMotion) {
      setN(value);
      return;
    }
    spring.set(value);
    const unsub = spring.on("change", (v) => setN(Math.round(v)));
    return () => unsub();
  }, [active, reduceMotion, value, spring]);
  return (
    <div className="font-mono" role="group" aria-label={`${value} ${label}`}>
      <div
        aria-hidden="true"
        className="text-4xl font-semibold text-pw-paper tabular-nums"
      >
        {n}
      </div>
      <div
        aria-hidden="true"
        className="mt-1 text-[11px] uppercase tracking-wider text-white/50"
      >
        {label}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Demo 7 — pricing tier micro-tilt                                       */
/* ---------------------------------------------------------------------- */

const TIERS = [
  { name: "sandbox", price: "$0", per: "free" },
  { name: "studio_lifetime", price: "$349", per: "once" },
  {
    name: "cloud_sending",
    price: "$29",
    per: "monthly · up to 50K managed sends",
    featured: true,
  },
  {
    name: "pro_sending",
    price: "$79",
    per: "monthly · up to 250K managed sends",
  },
];

function Demo7() {
  return (
    <DemoSection
      id="demo-7"
      title="7. Pricing tier micro-tilt"
      blurb="Hover any card. y:-2 lift + 150ms ember border-color shift. Resend keeps theirs to 2-3px max. Anything bigger reads as marketing site, not tool."
    >
      <div
        role="list"
        aria-label="Illustrative pricing tiers"
        className="grid gap-4 md:grid-cols-2 lg:grid-cols-4"
      >
        {TIERS.map((t) => (
          <motion.div
            key={t.name}
            role="listitem"
            tabIndex={0}
            aria-label={`${t.name}, ${t.price} ${t.per}`}
            whileHover={{ y: -2 }}
            whileFocus={{ y: -2 }}
            transition={{ duration: 0.15 }}
            className="group flex flex-col rounded-lg border border-white/10 bg-black/40 p-5 hover:border-pw-ember-500/70 focus-visible:border-pw-ember-500/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pw-ember-400 motion-reduce:!transform-none"
          >
            <div className="font-mono text-[10px] uppercase tracking-wider text-white/50">
              tier
            </div>
            <div className="mt-1 font-mono text-sm text-pw-ember-300">
              {t.name}
            </div>
            <div className="mt-4 flex items-baseline gap-2">
              <span className="font-mono text-3xl font-semibold text-pw-paper">
                {t.price}
              </span>
              <span className="font-mono text-[11px] text-white/50">
                {t.per}
              </span>
            </div>
          </motion.div>
        ))}
      </div>
    </DemoSection>
  );
}

/* ---------------------------------------------------------------------- */
/* Section wrapper                                                        */
/* ---------------------------------------------------------------------- */

function DemoSection({
  id,
  title,
  blurb,
  children,
}: {
  id: string;
  title: string;
  blurb: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="scroll-mt-28 border-b border-white/10 lg:scroll-mt-16"
    >
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <div className="text-xs font-mono uppercase tracking-widest text-pw-ember-300">
          Demo
        </div>
        <h2
          id={`${id}-title`}
          className="mt-3 text-2xl md:text-3xl font-semibold tracking-tight"
        >
          {title}
        </h2>
        <p className="mt-3 max-w-2xl text-white/60">{blurb}</p>
        <div className="mt-10">{children}</div>
      </div>
    </section>
  );
}
