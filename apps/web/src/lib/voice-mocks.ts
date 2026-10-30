// SPDX-License-Identifier: AGPL-3.0-only
//
// Substantive mock data for the voice service. Used when
// NEXT_PUBLIC_USE_MOCKS=1.

import type {
  AddSourceParams,
  CreateSequenceRequest,
  GenerationStatus,
  RegenerateEmailRequest,
  Sequence,
  SequenceEmail,
  SequenceListItem,
  SequenceTemplate,
  VoiceProfile,
  VoiceSource,
} from "./voice-types";

// ----- Templates ---------------------------------------------------------

type TemplateCategory =
  | "Welcome"
  | "Course Launch"
  | "Product Launch"
  | "Re-engagement"
  | "Newsletter"
  | "Webinar"
  | "Onboarding"
  | "Sales"
  | "Nurture"
  | "Lead Magnet";

function tpl(
  id: string,
  name: string,
  description: string,
  category: TemplateCategory,
  length: number,
  variableExtras: SequenceTemplate["variables"] = [],
): SequenceTemplate {
  return {
    id,
    slug: id,
    name,
    description,
    category,
    length,
    variables: [
      {
        key: "audience",
        label: "Audience",
        description: "Who is this sequence written to?",
        type: "text",
        example: "indie founders building on the side",
        required: true,
      },
      {
        key: "promise",
        label: "Promise",
        description: "What will the reader get from this sequence?",
        type: "longtext",
        example:
          "A weekly look at deliverability, voice, and growth tactics that work for solo operators.",
        required: true,
      },
      ...variableExtras,
    ],
    emails: Array.from({ length }, (_, i) => ({
      position: i + 1,
      subjectHint: `Email ${i + 1} subject`,
      bodyHint: `Email ${i + 1} body — first principles, your voice, no filler.`,
      delayHours: i === 0 ? 0 : 24 * i,
    })),
  };
}

const TEMPLATES: SequenceTemplate[] = [
  tpl(
    "welcome-warm",
    "Warm welcome",
    "Greet new subscribers in your voice and set expectations.",
    "Welcome",
    5,
  ),
  tpl(
    "welcome-founder",
    "Founder's welcome",
    "Personal welcome from the founder, sets the tone.",
    "Welcome",
    3,
  ),
  tpl(
    "welcome-7day",
    "7-day welcome series",
    "A full week of quality content for new subs.",
    "Welcome",
    7,
    [
      {
        key: "lead_magnet",
        label: "Lead magnet name",
        description: "What did they sign up for?",
        type: "text",
        example: "The 2026 deliverability checklist",
        required: true,
      },
    ],
  ),
  tpl(
    "course-prelaunch",
    "Course pre-launch",
    "Build anticipation before opening cart.",
    "Course Launch",
    5,
  ),
  tpl(
    "course-launch",
    "Course launch (cart open)",
    "Open cart, drive enrollments, handle objections.",
    "Course Launch",
    7,
  ),
  tpl(
    "course-cart-close",
    "Cart close (last 48h)",
    "Final 48 hours, scarcity-aware.",
    "Course Launch",
    4,
  ),
  tpl(
    "course-cohort",
    "Cohort kickoff",
    "Welcome enrolled students into the cohort.",
    "Course Launch",
    3,
  ),
  tpl(
    "product-prelaunch",
    "Product pre-launch",
    "Tease, validate, and warm the list.",
    "Product Launch",
    5,
  ),
  tpl(
    "product-launch",
    "Product launch",
    "Day-of launch sequence with social proof.",
    "Product Launch",
    6,
  ),
  tpl(
    "product-postlaunch",
    "Post-launch nurture",
    "Convert non-buyers post-launch.",
    "Product Launch",
    4,
  ),
  tpl(
    "reengage-30",
    "30-day re-engagement",
    "Win back subscribers who've gone quiet.",
    "Re-engagement",
    4,
  ),
  tpl(
    "reengage-90",
    "90-day win-back",
    "Last call before sunsetting cold subs.",
    "Re-engagement",
    3,
  ),
  tpl(
    "reengage-survey",
    "Survey re-engagement",
    "Ask what they want next.",
    "Re-engagement",
    2,
  ),
  tpl(
    "newsletter-weekly",
    "Weekly newsletter rhythm",
    "Cadence-establishing intro series.",
    "Newsletter",
    4,
  ),
  tpl(
    "newsletter-best-of",
    "Best-of greatest hits",
    "Send your top archive pieces to new subs.",
    "Newsletter",
    5,
  ),
  tpl(
    "webinar-invite",
    "Webinar invitation",
    "Drive registrations with story-led copy.",
    "Webinar",
    4,
  ),
  tpl(
    "webinar-followup",
    "Webinar follow-up",
    "Replay + offer for attendees and no-shows.",
    "Webinar",
    3,
  ),
  tpl(
    "onboarding-saas",
    "SaaS onboarding",
    "Activation-focused onboarding for product users.",
    "Onboarding",
    6,
  ),
  tpl(
    "onboarding-aha",
    "First-value onboarding",
    "Get them to their aha moment fast.",
    "Onboarding",
    4,
  ),
  tpl(
    "onboarding-power",
    "Power-user onboarding",
    "Deepen product use with advanced features.",
    "Onboarding",
    5,
  ),
  tpl(
    "sales-pitch",
    "Soft sales sequence",
    "Story-first pitch with a quiet ask.",
    "Sales",
    5,
  ),
  tpl(
    "sales-objection",
    "Objection-handler series",
    "Tackle the four common objections.",
    "Sales",
    4,
  ),
  tpl(
    "sales-flash",
    "Flash sale (72h)",
    "Three days, three emails, real urgency.",
    "Sales",
    3,
  ),
  tpl(
    "nurture-90",
    "90-day nurture",
    "Long-form nurture for top-of-funnel leads.",
    "Nurture",
    7,
  ),
  tpl(
    "nurture-thought",
    "Thought-leadership nurture",
    "Position the founder as the obvious choice.",
    "Nurture",
    6,
  ),
  tpl(
    "nurture-case",
    "Case-study nurture",
    "Three customer stories, one ask.",
    "Nurture",
    4,
  ),
  tpl(
    "magnet-delivery",
    "Lead-magnet delivery",
    "Deliver the magnet, then follow up.",
    "Lead Magnet",
    4,
  ),
  tpl(
    "magnet-tripwire",
    "Magnet → tripwire",
    "Magnet → low-ticket offer pipeline.",
    "Lead Magnet",
    5,
  ),
  tpl(
    "magnet-survey",
    "Survey lead magnet",
    "Use the survey results to segment.",
    "Lead Magnet",
    3,
  ),
  tpl(
    "magnet-challenge",
    "5-day challenge",
    "Daily prompts for a week, drive engagement.",
    "Lead Magnet",
    5,
  ),
];

function getTemplates(): SequenceTemplate[] {
  return TEMPLATES;
}

// ----- Voice Profile -----------------------------------------------------

const SAMPLE_PROFILE: VoiceProfile = {
  builtAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
  status: "ready",
  itemCount: 142,
  stylistic: [
    { key: "sentence_len", label: "Short sentences", weight: 0.78 },
    { key: "paragraph_len", label: "Tight paragraphs", weight: 0.84 },
    { key: "questions", label: "Rhetorical questions", weight: 0.41 },
    { key: "lists", label: "Bulleted lists", weight: 0.55 },
    { key: "em_dash", label: "Em-dash usage", weight: 0.92 },
    { key: "you_voice", label: "Second-person address", weight: 0.69 },
    { key: "metaphor", label: "Metaphor density", weight: 0.36 },
    { key: "humor", label: "Dry humor", weight: 0.47 },
  ],
  tonal: [
    { key: "formality", label: "Casual ↔ Formal", value: -0.4 },
    { key: "warmth", label: "Cool ↔ Warm", value: 0.5 },
    { key: "playfulness", label: "Serious ↔ Playful", value: 0.2 },
    { key: "directness", label: "Hedging ↔ Direct", value: 0.7 },
    { key: "authority", label: "Peer ↔ Authority", value: 0.1 },
  ],
  vocabulary: [
    { term: "deliverability", weight: 0.94 },
    { term: "compounding", weight: 0.82 },
    { term: "first principles", weight: 0.79 },
    { term: "real talk", weight: 0.74 },
    { term: "the boring part", weight: 0.71 },
    { term: "tiny systems", weight: 0.68 },
    { term: "leverage", weight: 0.62 },
    { term: "momentum", weight: 0.58 },
    { term: "the right reader", weight: 0.55 },
    { term: "the inbox", weight: 0.52 },
    { term: "ship", weight: 0.49 },
    { term: "writers' brain", weight: 0.41 },
  ],
  samples: [
    {
      id: "s1",
      title: "On writing the first email",
      excerpt:
        "The first email isn't a welcome — it's a promise. You're saying: this is what we'll do here, week after week. Make it small enough to keep.",
      sourceLabel: "Newsletter, Mar 2025",
    },
    {
      id: "s2",
      title: "Why I stopped chasing opens",
      excerpt:
        "Open rates are a vanity metric in 2026. The boring part — deliverability, list hygiene, list-growth quality — is where the compounding lives.",
      sourceLabel: "Blog, Aug 2025",
    },
    {
      id: "s3",
      title: "Cohort thread",
      excerpt:
        "Three things I learned from running a 12-week cohort: keep the calendar light, raise the floor on quality, and never apologize for shipping.",
      sourceLabel: "Twitter, Jan 2026",
    },
  ],
};

let profileState: VoiceProfile | null = SAMPLE_PROFILE;

function getProfile(): VoiceProfile | null {
  return profileState;
}

function buildProfile(): VoiceProfile {
  profileState = { ...SAMPLE_PROFILE, builtAt: new Date().toISOString() };
  return profileState;
}

// ----- Sources -----------------------------------------------------------

const SOURCES: VoiceSource[] = [
  {
    id: "src-newsletter",
    type: "newsletter_archive",
    label: "Substack archive — fieldnotes.substack.com",
    itemCount: 87,
    lastIngestedAt: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(),
    status: "ready",
  },
  {
    id: "src-twitter",
    type: "twitter",
    label: "@yourhandle",
    itemCount: 41,
    lastIngestedAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
    status: "ready",
  },
  {
    id: "src-blog",
    type: "blog_rss",
    label: "Blog RSS — yourblog.com/feed",
    itemCount: 14,
    lastIngestedAt: new Date(
      Date.now() - 8 * 24 * 60 * 60 * 1000,
    ).toISOString(),
    status: "ready",
  },
  {
    id: "src-linkedin",
    type: "linkedin_export",
    label: "LinkedIn export — uploads/linkedin-posts.csv",
    itemCount: 23,
    lastIngestedAt: new Date(
      Date.now() - 3 * 24 * 60 * 60 * 1000,
    ).toISOString(),
    status: "ready",
  },
  {
    id: "src-podcast",
    type: "podcast_transcript",
    label: "Podcast transcript — Founder AMA",
    itemCount: 9,
    lastIngestedAt: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
    status: "ready",
  },
];

function listSources(): VoiceSource[] {
  return [...SOURCES];
}

function addSource(params: AddSourceParams): VoiceSource {
  const id = `src-${Date.now().toString(36)}`;
  const label =
    params.label ??
    (params.type === "newsletter_archive"
      ? "Moosewave campaign archive"
      : params.type === "twitter"
        ? params.handle
        : params.type === "blog_rss"
          ? params.feedUrl
          : params.type === "linkedin_export"
            ? params.label || params.archivePath || "LinkedIn CSV export"
            : params.type === "podcast_transcript"
              ? params.title || "Podcast transcript"
              : "Pasted text");
  const next: VoiceSource = {
    id,
    type: params.type,
    label,
    itemCount: 0,
    lastIngestedAt: null,
    status: "pending",
  };
  SOURCES.push(next);
  return next;
}

function ingestSource(id: string): VoiceSource {
  const src = SOURCES.find((s) => s.id === id);
  if (!src) throw new Error(`source not found: ${id}`);
  src.itemCount += 12;
  src.lastIngestedAt = new Date().toISOString();
  src.status = "ready";
  return src;
}

// ----- Sequences ---------------------------------------------------------

const SAMPLE_WELCOME_BODIES: { subject: string; body: string }[] = [
  {
    subject: "You're in. Here's what I owe you.",
    body: "Hey — welcome aboard.\n\nYou signed up because you want fewer fluff emails and more of the boring part: deliverability, voice, and growth that actually compounds. I'll keep that promise.\n\nHere's the deal for the next week: one email a day, each one worth your time, none of them long enough to need a coffee break.\n\nReply to this one and tell me what you're working on. I read everything.\n\n— V",
  },
  {
    subject: "The first thing I'd fix if I were you",
    body: "If your list is under 5,000 subs and your open rate just dropped, it's almost never the copy.\n\nIt's the inbox. Deliverability is a quiet tax on every email you'll ever send, and most newsletters don't realize they're paying it until the spam folder eats a launch.\n\nThree things to check today:\n\n- Are you authenticated (SPF/DKIM/DMARC)?\n- Is your domain warmed up, or are you sending cold from a fresh subdomain?\n- Are you pruning unengaged subscribers, or hoarding them like a dragon?\n\nMore tomorrow.",
  },
  {
    subject: "Why I stopped chasing open rates",
    body: "Open rates are a vanity metric in 2026. Apple Mail Privacy ate them in 2021 and we kept pretending they meant something.\n\nWhat actually matters: replies, clicks to high-intent links, and the unsubscribe rate after a real-talk email. Those tell you whether your reader is leaning in or drifting off.\n\nI'll show you my dashboard tomorrow.",
  },
  {
    subject: "My one-page newsletter dashboard",
    body: "I track four numbers, weekly:\n\n- Reply rate (real signal)\n- Click-through to long-form (intent signal)\n- Unsubscribe rate after each issue (mismatch signal)\n- Growth from forwards (delight signal)\n\nThat's the whole dashboard. No charts, no funnels, no cohorts. Four numbers, one page, ten minutes a week.\n\nKeep it small enough to keep.",
  },
  {
    subject: "Real talk: what I'd do with my first 1,000 subs",
    body: "If I had to start over with zero list and one quiet hour a day, here's the order I'd do things:\n\n1. Nail the promise. One sentence, no commas, no qualifiers.\n2. Write twelve issues before I ever ran an ad or a giveaway.\n3. Set up a tiny welcome sequence (this one is fine — steal it).\n4. Then, and only then, would I start growing.\n\nThe order matters more than the tactics.",
  },
  {
    subject: "Tiny systems beat big plans",
    body: "Big plans collapse on contact with a busy week. Tiny systems survive.\n\nFor the newsletter, that's looked like: a Friday-morning writing block I never move, a Tuesday list-hygiene cron, and a quarterly archive review that takes an afternoon.\n\nNothing impressive. All compounding.",
  },
  {
    subject: "Last one (and a quiet ask)",
    body: "That's the welcome series. From here on out it's one email most weeks, on whatever I'm thinking about.\n\nA quiet ask: hit reply and tell me one thing you'd like me to write about. I keep a running file of reader prompts and they make the best issues.\n\n— V",
  },
];

let sequencesState: Sequence[] = (() => {
  const id = "seq-welcome-sample";
  const now = Date.now();
  const emails: SequenceEmail[] = SAMPLE_WELCOME_BODIES.map((b, i) => ({
    id: `em-${i + 1}`,
    position: i + 1,
    subject: b.subject,
    bodyMarkdown: b.body,
    bodyHtml: "",
    bodyMjml: null,
    delayHours: i === 0 ? 0 : 24 * i,
    fidelity: 78 + ((i * 7) % 17),
    fidelityBreakdown: {
      embedding: 80 + ((i * 5) % 13),
      stylistic: 75 + ((i * 3) % 19),
      vocab: 70 + ((i * 11) % 21),
      structural: 82 + ((i * 2) % 13),
    },
  }));
  const fidelityAvg = Math.round(
    emails.reduce((a, e) => a + e.fidelity, 0) / emails.length,
  );
  return [
    {
      id,
      version: 1,
      name: "Welcome series — fieldnotes",
      templateId: "welcome-7day",
      templateName: "7-day welcome series",
      status: "draft",
      fidelityAvg,
      emails,
      createdAt: new Date(now - 60_000).toISOString(),
      updatedAt: new Date(now).toISOString(),
    },
  ];
})();

function listSequences(): SequenceListItem[] {
  return sequencesState.map((s) => ({
    id: s.id,
    name: s.name,
    templateName: s.templateName,
    status: s.status,
    fidelityAvg: s.fidelityAvg,
    updatedAt: s.updatedAt,
    emailCount: s.emails.length,
  }));
}

function getSequence(id: string): Sequence {
  const s = sequencesState.find((x) => x.id === id);
  if (!s) throw new Error(`sequence not found: ${id}`);
  return s;
}

function createSequence(req: CreateSequenceRequest): Sequence {
  const tpl = TEMPLATES.find((t) => t.id === req.templateId);
  if (!tpl && !req.steps?.length) {
    throw new Error(`template not found: ${req.templateId}`);
  }
  const id = `seq-${Date.now().toString(36)}`;
  const audience = req.variables?.audience ?? "your readers";
  const emails: SequenceEmail[] = req.steps?.length
    ? req.steps
        .filter((step) => step.type === "email")
        .map((step, i) => ({
          id: `em-${i + 1}`,
          position: step.position,
          subject: step.email.subject,
          bodyMarkdown: step.email.body ?? "",
          bodyHtml: step.email.body_html ?? "",
          bodyMjml: step.email.body_mjml ?? null,
          delayHours: (step.email.delay_seconds ?? 0) / 3600,
          fidelity: 0,
          fidelityBreakdown: {
            embedding: 0,
            stylistic: 0,
            vocab: 0,
            structural: 0,
          },
        }))
    : tpl!.emails.map((e, i) => ({
        id: `em-${i + 1}`,
        position: e.position,
        subject:
          i === 0
            ? "You're in. Here's what we'll do here."
            : `Email ${e.position} — ${tpl!.name.toLowerCase()}`,
        bodyMarkdown:
          `Welcome — this email is being generated in your voice for ${audience}.\n\n` +
          `In the production build, this body comes from the voice service after corpus retrieval and fidelity scoring.\n\n` +
          `For now: a placeholder that respects your style sliders (humor=${req.style?.humor ?? 0}, directness=${req.style?.directness ?? 0}).`,
        bodyHtml: "",
        bodyMjml: null,
        delayHours: e.delayHours,
        fidelity: 70 + ((i * 9) % 25),
        fidelityBreakdown: {
          embedding: 75 + ((i * 5) % 20),
          stylistic: 70 + ((i * 7) % 22),
          vocab: 65 + ((i * 11) % 25),
          structural: 80 + ((i * 3) % 15),
        },
      }));
  const fidelityAvg = Math.round(
    emails.length
      ? emails.reduce((a, e) => a + e.fidelity, 0) / emails.length
      : 0,
  );
  const now = new Date().toISOString();
  const seq: Sequence = {
    id,
    version: 1,
    name: req.name ?? (tpl ? `${tpl.name} — draft` : "Manual sequence"),
    templateId: tpl?.id ?? "",
    templateName: tpl?.name ?? "Manual sequence",
    status: "draft",
    fidelityAvg,
    emails,
    steps: req.steps,
    ...(req.goal !== undefined ? { goal: req.goal } : {}),
    ...(req.stuckAfterDays !== undefined
      ? { stuckAfterDays: req.stuckAfterDays }
      : {}),
    createdAt: now,
    updatedAt: now,
  };
  sequencesState = [seq, ...sequencesState];
  return seq;
}

function updateSequence(
  candidate: Sequence,
  expectedVersion: number,
): Sequence {
  const index = sequencesState.findIndex(
    (sequence) => sequence.id === candidate.id,
  );
  if (index < 0) throw new Error(`sequence not found: ${candidate.id}`);
  const current = sequencesState[index]!;
  if (current.status !== "draft" || candidate.status !== "draft") {
    throw new Error("Only confirmed draft sequences can be edited.");
  }
  if (current.version !== expectedVersion) {
    throw new Error("Sequence version conflict. Reload the latest draft.");
  }
  const next: Sequence = {
    ...candidate,
    status: "draft",
    version: expectedVersion + 1,
    updatedAt: new Date().toISOString(),
  };
  sequencesState[index] = next;
  return next;
}

function archiveSequence(id: string, expectedVersion: number): Sequence {
  const index = sequencesState.findIndex((sequence) => sequence.id === id);
  if (index < 0) throw new Error(`sequence not found: ${id}`);
  const current = sequencesState[index]!;
  if (current.status !== "draft") {
    throw new Error("Only confirmed draft sequences can be archived.");
  }
  if (current.version !== expectedVersion) {
    throw new Error("Sequence version conflict. Reload the latest draft.");
  }
  const next: Sequence = {
    ...current,
    status: "archived",
    version: expectedVersion + 1,
    updatedAt: new Date().toISOString(),
  };
  sequencesState[index] = next;
  return next;
}

function unarchiveSequence(id: string, expectedVersion: number): Sequence {
  const index = sequencesState.findIndex((sequence) => sequence.id === id);
  if (index < 0) throw new Error(`sequence not found: ${id}`);
  const current = sequencesState[index]!;
  if (current.status !== "archived") {
    throw new Error("Only archived sequences can be restored to a draft.");
  }
  if (current.version !== expectedVersion) {
    throw new Error("Sequence version conflict. Reload the latest draft.");
  }
  const next: Sequence = {
    ...current,
    status: "draft",
    version: expectedVersion + 1,
    updatedAt: new Date().toISOString(),
  };
  sequencesState[index] = next;
  return next;
}

function getGenerationStatus(id: string): GenerationStatus {
  const s = sequencesState.find((x) => x.id === id);
  if (!s) {
    return {
      sequenceId: id,
      state: "error",
      progress: 0,
      message: "sequence not found",
    };
  }
  return {
    sequenceId: id,
    state: "ready",
    progress: 1,
    message: "Generated.",
  };
}

function regenerateEmail(
  seqId: string,
  position: number,
  req: RegenerateEmailRequest,
): SequenceEmail {
  const s = sequencesState.find((x) => x.id === seqId);
  if (!s) throw new Error(`sequence not found: ${seqId}`);
  const e = s.emails.find((x) => x.position === position);
  if (!e) throw new Error(`email not found at position ${position}`);
  // Match the live preview contract: return a detached candidate and never
  // mutate the stored draft until an explicit, versioned accept exists.
  return {
    ...e,
    bodyMarkdown:
      (req.hint ? `(reflecting hint: ${req.hint})\n\n` : "") +
      e.bodyMarkdown.replace(/^/, "↻ regenerated candidate\n\n"),
    fidelity: Math.min(100, e.fidelity + 3),
  };
}

export const voiceMocks = {
  getTemplates,
  getProfile,
  buildProfile,
  listSources,
  addSource,
  ingestSource,
  listSequences,
  getSequence,
  createSequence,
  updateSequence,
  archiveSequence,
  unarchiveSequence,
  getGenerationStatus,
  regenerateEmail,
};
