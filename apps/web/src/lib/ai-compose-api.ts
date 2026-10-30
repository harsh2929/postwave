/**
 * lib/ai-compose-api.ts — the LLM-backed endpoints.
 *
 * Six paths desktop reached and no web file did.
 *
 * COVERAGE: this module wires all six:
 *   /api/v1/ai/compose/broadcast
 *   /api/v1/ai/compose/variants
 *   /api/v1/ai/subject-lines/generate
 *   /api/v1/analytics/nlq
 *   /api/v1/analytics/anomaly-brief
 *   /api/v1/voice/drift
 *
 * Provider credentials are tenant-scoped and the API intentionally returns
 * the same unavailable state for missing configuration and upstream outage.
 * The UI therefore reports only the verified fact that AI is unavailable;
 * it never guesses which provider remedy an operator should take.
 *
 * The request shapes below are taken from the Go input structs, not guessed:
 * broadcast takes `brief`, variants takes `subject`+`body` (NOT `brief` —
 * that shape is rejected), subject lines take `prompt`.
 */
import { api, ApiError } from "@/lib/api";

export type AiOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; unavailable: true };

/** True for the error every LLM path returns when the provider is unreachable. */
export function isAiUnavailable(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  return (
    err.status === 503 ||
    err.code === "upstream_unavailable" ||
    err.code === "voice_unavailable" ||
    err.code === "nlq_unavailable" ||
    err.code === "internal_error" ||
    err.code === "feature_disabled"
  );
}

async function call<T>(fn: () => Promise<T>): Promise<AiOutcome<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    if (isAiUnavailable(err)) return { ok: false, unavailable: true };
    throw err;
  }
}

export interface ComposedDraft {
  name: string;
  subject: string;
  body: string;
  preview_text?: string;
}

export interface ComposedBroadcast {
  primary: ComposedDraft;
  subjectVariants: string[];
  generatedAt: string;
}

export interface ComposedVariants {
  subjectVariants: string[];
  generatedAt: string;
}

export interface GeneratedSubjectLines {
  candidates: string[];
  generatedAt: string;
  fallback: boolean;
}

export interface ScoredSubjectLine {
  text: string;
  axis: string;
  predictedOpen: number;
  ciLow: number;
  ciHigh: number;
  matchedCount: number;
  lowConfidence: boolean;
  belowBaseline: boolean;
}

export interface SubjectLineScores {
  baselineOpen: number;
  windowDays: number;
  variants: ScoredSubjectLine[];
}

export interface TopPerformingSubject {
  campaignId: string;
  name: string;
  subject: string;
  sentAt: string;
  recipients: number;
  opens: number;
  clicks: number;
  openRate: number;
  clickRate: number;
}

export interface TopPerformingSubjects {
  windowDays: number;
  minRecipients: number;
  top: TopPerformingSubject[];
}

export interface AnalyticsAnswer {
  answerKind: "table" | "summary";
  template: string;
  columns: string[];
  rows: Array<Record<string, string | number | boolean | null>>;
  summaryText: string;
  generatedAt: string;
}

export type AnomalyMetric =
  | "opens"
  | "clicks"
  | "bounces"
  | "complaints"
  | "unsubscribes"
  | "revenue";

export interface AnomalyBriefResult {
  metric: AnomalyMetric;
  windowDays: number;
  summary: string;
  probableCauses: string[];
  suggestedActions: string[];
  currentTotal: number;
  previousTotal: number;
  daily: Array<{ day: string; value: number }>;
  topCampaigns: Array<{
    campaignId: string;
    campaignName: string;
    value: number;
  }>;
  revenueScope?: {
    currency: string | null;
    monetaryConversionCount: number;
    excludedCurrencyCount: number;
  };
  generatedAt: string;
}

const AI_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const AI_TIMESTAMP_MAX = 64;
const AI_SUBJECT_MAX = 998;
const AI_BODY_MAX = 200_000;
const AI_CALL_OPTIONS = {
  requireOnline: true,
  maxAttempts: 1,
  timeoutMs: 90_000,
} as const;

function aiRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid " + label + " response");
  }
  return value as Record<string, unknown>;
}

function aiText(
  value: unknown,
  label: string,
  maximum: number,
  allowEmpty = false,
): string {
  if (typeof value !== "string" || value.length > maximum) {
    throw new Error("Invalid " + label);
  }
  const normalized = value.trim();
  if (!allowEmpty && !normalized) throw new Error("Invalid " + label);
  return normalized;
}

function aiInteger(
  value: unknown,
  label: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error("Invalid " + label);
  }
  return value;
}

function aiNumber(
  value: unknown,
  label: string,
  minimum = Number.MIN_SAFE_INTEGER,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error("Invalid " + label);
  }
  return value;
}

function aiTimestamp(value: unknown, label: string): string {
  const result = aiText(value, label, AI_TIMESTAMP_MAX);
  if (!Number.isFinite(Date.parse(result))) throw new Error("Invalid " + label);
  return result;
}

function aiStringList(
  value: unknown,
  label: string,
  maximumItems: number,
  maximumLength: number,
  minimumItems = 0,
): string[] {
  if (
    !Array.isArray(value) ||
    value.length < minimumItems ||
    value.length > maximumItems
  ) {
    throw new Error("Invalid " + label);
  }
  const seen = new Set<string>();
  return value.map((item) => {
    const result = aiText(item, label + " item", maximumLength);
    const identity = result.toLocaleLowerCase();
    if (seen.has(identity)) throw new Error("Duplicate " + label + " item");
    seen.add(identity);
    return result;
  });
}

function validateAiInput(
  value: string,
  label: string,
  minimum: number,
  maximum: number,
): string {
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new Error(
      label +
        " must be between " +
        String(minimum) +
        " and " +
        String(maximum) +
        " characters.",
    );
  }
  return normalized;
}

function optionalAiInput(
  value: string | undefined,
  label: string,
  maximum: number,
): string {
  const normalized = value?.trim() ?? "";
  if (normalized.length > maximum) {
    throw new Error(
      label + " must be " + String(maximum) + " characters or fewer.",
    );
  }
  return normalized;
}

export function parseComposedBroadcast(value: unknown): ComposedBroadcast {
  const root = aiRecord(value, "AI broadcast");
  const primary = aiRecord(root.primary, "AI broadcast draft");
  const subject = aiText(primary.subject, "AI draft subject", AI_SUBJECT_MAX);
  const name = aiText(primary.name, "AI draft name", 500, true) || subject;
  const variants = aiStringList(
    root.subject_variants,
    "AI subject variants",
    5,
    AI_SUBJECT_MAX,
    1,
  );
  if (!variants.some((candidate) => candidate === subject)) {
    throw new Error("AI subject variants omit the primary subject");
  }
  return {
    primary: {
      name,
      subject,
      body: aiText(primary.body, "AI draft body", AI_BODY_MAX),
      ...(primary.preview_text === undefined
        ? {}
        : {
            preview_text: aiText(
              primary.preview_text,
              "AI draft preview text",
              2_000,
              true,
            ),
          }),
    },
    subjectVariants: variants,
    generatedAt: aiTimestamp(root.generated_at, "AI generation time"),
  };
}

export function parseComposedVariants(value: unknown): ComposedVariants {
  const root = aiRecord(value, "AI variants");
  return {
    subjectVariants: aiStringList(
      root.subject_variants,
      "AI subject variants",
      5,
      AI_SUBJECT_MAX,
      1,
    ),
    generatedAt: aiTimestamp(root.generated_at, "AI generation time"),
  };
}

export function parseGeneratedSubjectLines(
  value: unknown,
): GeneratedSubjectLines {
  const root = aiRecord(value, "AI subject lines");
  if (root.fallback !== undefined && typeof root.fallback !== "boolean") {
    throw new Error("Invalid AI subject-line fallback state");
  }
  return {
    candidates: aiStringList(
      root.candidates,
      "AI subject candidates",
      5,
      AI_SUBJECT_MAX,
      1,
    ),
    generatedAt: aiTimestamp(root.generated_at, "AI generation time"),
    fallback: root.fallback === true,
  };
}

export function parseSubjectLineScores(value: unknown): SubjectLineScores {
  const root = aiRecord(value, "subject-line scores");
  if (!Array.isArray(root.variants) || root.variants.length > 16) {
    throw new Error("Invalid subject-line score rows");
  }
  const seen = new Set<string>();
  const variants = root.variants.map((item) => {
    const row = aiRecord(item, "subject-line score");
    const text = aiText(row.text, "scored subject", AI_SUBJECT_MAX);
    const identity = text.toLocaleLowerCase();
    if (seen.has(identity)) throw new Error("Duplicate scored subject");
    seen.add(identity);
    const predictedOpen = aiNumber(
      row.predicted_open,
      "predicted open rate",
      0,
      1,
    );
    const ciLow = aiNumber(row.ci_low, "open-rate lower bound", 0, 1);
    const ciHigh = aiNumber(row.ci_high, "open-rate upper bound", 0, 1);
    if (ciLow > predictedOpen || predictedOpen > ciHigh) {
      throw new Error("Invalid subject-line confidence interval");
    }
    if (
      typeof row.low_confidence !== "boolean" ||
      typeof row.below_baseline !== "boolean"
    ) {
      throw new Error("Invalid subject-line score confidence state");
    }
    return {
      text,
      // The score endpoint deliberately returns an empty axis: unlike the
      // separate axis-generation endpoint, these candidates came from a
      // free-form brief. Preserve that verified empty state.
      axis: aiText(row.axis, "subject-line score axis", 100, true),
      predictedOpen,
      ciLow,
      ciHigh,
      matchedCount: aiInteger(row.matched_n, "matched campaign count"),
      lowConfidence: row.low_confidence,
      belowBaseline: row.below_baseline,
    };
  });
  return {
    baselineOpen: aiNumber(root.baseline_open, "baseline open rate", 0, 1),
    windowDays: aiInteger(root.window_days, "score window", 1, 365),
    variants,
  };
}

export function parseTopPerformingSubjects(
  value: unknown,
): TopPerformingSubjects {
  const root = aiRecord(value, "top-performing subjects");
  if (!Array.isArray(root.top) || root.top.length > 25) {
    throw new Error("Invalid top-performing subject rows");
  }
  const seen = new Set<string>();
  const top = root.top.map((item) => {
    const row = aiRecord(item, "top-performing subject");
    const campaignId = aiText(
      row.campaign_id,
      "top-performing campaign identity",
      64,
    ).toLowerCase();
    if (!AI_UUID.test(campaignId) || seen.has(campaignId)) {
      throw new Error("Invalid top-performing campaign identity");
    }
    seen.add(campaignId);
    const recipients = aiInteger(
      row.recipients,
      "top-performing recipient count",
    );
    const opens = aiInteger(row.opens, "top-performing open count");
    const clicks = aiInteger(row.clicks, "top-performing click count");
    if (opens > recipients || clicks > recipients) {
      throw new Error("Invalid top-performing campaign counts");
    }
    const openRate = aiNumber(row.open_rate, "top-performing open rate", 0, 1);
    const clickRate = aiNumber(
      row.click_rate,
      "top-performing click rate",
      0,
      1,
    );
    if (
      recipients === 0 ||
      Math.abs(openRate - opens / recipients) > 1e-9 ||
      Math.abs(clickRate - clicks / recipients) > 1e-9
    ) {
      throw new Error("Top-performing campaign rates do not reconcile");
    }
    return {
      campaignId,
      name:
        aiText(row.name, "top-performing campaign name", 500, true) ||
        "Untitled campaign",
      subject: aiText(
        row.subject,
        "top-performing campaign subject",
        AI_SUBJECT_MAX,
      ),
      sentAt: aiTimestamp(row.sent_at, "top-performing campaign send time"),
      recipients,
      opens,
      clicks,
      openRate,
      clickRate,
    };
  });
  return {
    windowDays: aiInteger(root.window_days, "top-performer window", 1, 365),
    minRecipients: aiInteger(
      root.min_recipients,
      "top-performer minimum recipients",
      1,
    ),
    top,
  };
}

function aiScalar(
  value: unknown,
  label: string,
): string | number | boolean | null {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length <= 1_000) return value;
  throw new Error("Invalid " + label);
}

export function parseAnalyticsAnswer(value: unknown): AnalyticsAnswer {
  const root = aiRecord(value, "analytics answer");
  if (root.answer_kind !== "table" && root.answer_kind !== "summary") {
    throw new Error("Invalid analytics answer kind");
  }
  const columns = aiStringList(root.columns, "analytics columns", 20, 100);
  if (
    columns.some((column) => !/^[a-z][a-z0-9_]*$/u.test(column)) ||
    !Array.isArray(root.rows) ||
    root.rows.length > 200
  ) {
    throw new Error("Invalid analytics result table");
  }
  const rows = root.rows.map((item) => {
    const source = aiRecord(item, "analytics result row");
    const row: Record<string, string | number | boolean | null> = {};
    for (const column of columns) {
      if (!(column in source)) {
        throw new Error("Analytics result row is missing " + column);
      }
      row[column] = aiScalar(source[column], "analytics cell");
    }
    return row;
  });
  const trace = aiRecord(root.trace, "analytics trace");
  const template = aiText(root.template, "analytics template", 100);
  if (!/^[a-z][a-z0-9_]*$/u.test(template)) {
    throw new Error("Invalid analytics template identity");
  }
  return {
    answerKind: root.answer_kind,
    template,
    columns,
    rows,
    summaryText: aiText(root.summary_text, "analytics summary", 10_000, true),
    generatedAt: aiTimestamp(trace.generated_at, "analytics generation time"),
  };
}

const ANOMALY_METRICS = new Set<AnomalyMetric>([
  "opens",
  "clicks",
  "bounces",
  "complaints",
  "unsubscribes",
  "revenue",
]);

function parseAnomalyMetric(value: unknown): AnomalyMetric {
  if (
    typeof value !== "string" ||
    !ANOMALY_METRICS.has(value as AnomalyMetric)
  ) {
    throw new Error("Invalid anomaly metric");
  }
  return value as AnomalyMetric;
}

export function parseAnomalyBrief(value: unknown): AnomalyBriefResult {
  const root = aiRecord(value, "anomaly brief");
  const metric = parseAnomalyMetric(root.metric);
  const windowDays = aiInteger(root.window_days, "anomaly window", 1, 90);
  const aggregates = aiRecord(root.aggregates, "anomaly aggregates");
  if (
    aggregates.metric !== metric ||
    aggregates.window_days !== windowDays ||
    !Array.isArray(aggregates.daily) ||
    aggregates.daily.length > 90 ||
    !Array.isArray(aggregates.top_campaigns) ||
    aggregates.top_campaigns.length > 5
  ) {
    throw new Error("Invalid anomaly aggregate identity");
  }
  const dailyDays = new Set<string>();
  let previousDay = "";
  const minimumValue = metric === "revenue" ? Number.MIN_SAFE_INTEGER : 0;
  const daily = aggregates.daily.map((item) => {
    const row = aiRecord(item, "anomaly daily point");
    const day = aiText(row.day, "anomaly day", 10);
    const parsed = new Date(day + "T00:00:00Z");
    if (
      !/^\d{4}-\d{2}-\d{2}$/u.test(day) ||
      Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== day
    ) {
      throw new Error("Invalid anomaly day");
    }
    if (dailyDays.has(day) || (previousDay && day <= previousDay)) {
      throw new Error("Invalid anomaly day sequence");
    }
    dailyDays.add(day);
    previousDay = day;
    return {
      day,
      value: aiInteger(row.value, "anomaly daily value", minimumValue),
    };
  });
  const campaignIds = new Set<string>();
  const topCampaigns = aggregates.top_campaigns.map((item) => {
    const row = aiRecord(item, "anomaly campaign");
    const campaignId = aiText(
      row.campaign_id,
      "anomaly campaign identity",
      64,
    ).toLowerCase();
    if (!AI_UUID.test(campaignId) || campaignIds.has(campaignId)) {
      throw new Error("Invalid anomaly campaign identity");
    }
    campaignIds.add(campaignId);
    return {
      campaignId,
      campaignName: aiText(row.campaign_name, "anomaly campaign name", 500),
      value: aiInteger(row.value, "anomaly campaign value", minimumValue),
    };
  });
  let revenueScope: AnomalyBriefResult["revenueScope"];
  if (aggregates.revenue_scope !== undefined) {
    const scope = aiRecord(aggregates.revenue_scope, "anomaly revenue scope");
    const currency =
      scope.currency === null
        ? null
        : aiText(scope.currency, "anomaly currency", 3).toUpperCase();
    if (currency !== null && !/^[A-Z]{3}$/u.test(currency)) {
      throw new Error("Invalid anomaly currency");
    }
    revenueScope = {
      currency,
      monetaryConversionCount: aiInteger(
        scope.monetary_conversion_count,
        "anomaly monetary conversion count",
      ),
      excludedCurrencyCount: aiInteger(
        scope.excluded_currency_count,
        "anomaly excluded currency count",
      ),
    };
  }
  if (metric === "revenue" && !revenueScope) {
    throw new Error("Revenue anomaly scope is missing");
  }
  if (metric !== "revenue" && revenueScope) {
    throw new Error("Count anomaly unexpectedly includes revenue scope");
  }
  if (
    revenueScope &&
    ((revenueScope.monetaryConversionCount === 0 &&
      (revenueScope.currency !== null ||
        revenueScope.excludedCurrencyCount !== 0)) ||
      (revenueScope.monetaryConversionCount > 0 &&
        revenueScope.currency === null))
  ) {
    throw new Error("Revenue anomaly scope does not reconcile");
  }
  const currentTotal = aiInteger(
    aggregates.current_total,
    "current anomaly total",
    minimumValue,
  );
  const previousTotal = aiInteger(
    aggregates.previous_total,
    "previous anomaly total",
    minimumValue,
  );
  const dailyTotal = daily.reduce((sum, point) => sum + point.value, 0);
  if (!Number.isSafeInteger(dailyTotal) || dailyTotal !== currentTotal) {
    throw new Error("Anomaly daily series does not reconcile");
  }
  if (
    metric === "revenue" &&
    revenueScope?.monetaryConversionCount === 0 &&
    (currentTotal !== 0 ||
      previousTotal !== 0 ||
      daily.length !== 0 ||
      topCampaigns.length !== 0)
  ) {
    throw new Error("Empty revenue anomaly scope contains monetary evidence");
  }
  const trace = aiRecord(root.trace, "anomaly trace");
  return {
    metric,
    windowDays,
    summary: aiText(root.summary, "anomaly summary", 10_000),
    probableCauses: aiStringList(
      root.probable_causes,
      "probable anomaly causes",
      12,
      2_000,
    ),
    suggestedActions: aiStringList(
      root.suggested_actions,
      "suggested anomaly actions",
      12,
      2_000,
    ),
    currentTotal,
    previousTotal,
    daily,
    topCampaigns,
    ...(revenueScope ? { revenueScope } : {}),
    generatedAt: aiTimestamp(trace.generated_at, "anomaly generation time"),
  };
}

/** Drafts a whole broadcast from a one-line brief. */
export function composeBroadcast(
  brief: string,
  options: {
    tone?: string;
    audience?: string;
    variantCount?: number;
  } = {},
): Promise<AiOutcome<ComposedBroadcast>> {
  const normalizedBrief = validateAiInput(brief, "Brief", 3, 4_000);
  const tone = optionalAiInput(options.tone, "Tone", 100);
  const audience = optionalAiInput(options.audience, "Audience", 500);
  const variantCount = options.variantCount ?? 2;
  aiInteger(variantCount, "variant count", 0, 4);
  return call(async () =>
    parseComposedBroadcast(
      await api.post<unknown>(
        "/api/v1/ai/compose/broadcast",
        {
          brief: normalizedBrief,
          variant_count: variantCount,
          ...(tone ? { tone } : {}),
          ...(audience ? { audience } : {}),
        },
        AI_CALL_OPTIONS,
      ),
    ),
  );
}

/**
 * Alternate subject lines for an EXISTING draft.
 *
 * Takes `subject` and `body`, not `brief` — the server rejects a brief here,
 * because variants are anchored to real content rather than generated from a
 * prompt.
 */
export function composeVariants(
  subject: string,
  body: string,
  variantCount = 3,
): Promise<AiOutcome<ComposedVariants>> {
  const normalizedSubject = validateAiInput(
    subject,
    "Subject",
    1,
    AI_SUBJECT_MAX,
  );
  const normalizedBody = validateAiInput(body, "Body", 1, AI_BODY_MAX);
  aiInteger(variantCount, "variant count", 1, 5);
  return call(async () => {
    const response = await api.post<unknown>(
      "/api/v1/ai/compose/variants",
      {
        subject: normalizedSubject,
        body: normalizedBody,
        variant_count: variantCount,
      },
      AI_CALL_OPTIONS,
    );
    return parseComposedVariants(response);
  });
}

export function generateSubjectLines(
  prompt: string,
  options: {
    tone?: string;
    targetAudience?: string;
    variantCount?: number;
  } = {},
): Promise<AiOutcome<GeneratedSubjectLines>> {
  const normalizedPrompt = validateAiInput(prompt, "Prompt", 3, 2_048);
  const tone = optionalAiInput(options.tone, "Tone", 100);
  const targetAudience = optionalAiInput(
    options.targetAudience,
    "Target audience",
    500,
  );
  const variantCount = options.variantCount ?? 3;
  aiInteger(variantCount, "variant count", 1, 5);
  return call(async () =>
    parseGeneratedSubjectLines(
      await api.post<unknown>(
        "/api/v1/ai/subject-lines/generate",
        {
          prompt: normalizedPrompt,
          variant_count: variantCount,
          ...(tone ? { tone } : {}),
          ...(targetAudience ? { target_audience: targetAudience } : {}),
        },
        AI_CALL_OPTIONS,
      ),
    ),
  );
}

export function scoreSubjectLines(
  subjects: string[],
): Promise<SubjectLineScores> {
  const normalized = aiStringList(
    subjects,
    "subjects to score",
    16,
    AI_SUBJECT_MAX,
    1,
  );
  return api
    .post<unknown>(
      "/api/v1/subject-lab/score",
      { subjects: normalized },
      AI_CALL_OPTIONS,
    )
    .then(parseSubjectLineScores);
}

export function getTopPerformingSubjects(
  input: {
    days?: number;
    limit?: number;
    minRecipients?: number;
    signal?: AbortSignal;
  } = {},
): Promise<TopPerformingSubjects> {
  const days = input.days ?? 90;
  const limit = input.limit ?? 8;
  const minRecipients = input.minRecipients ?? 20;
  aiInteger(days, "top-performer window", 1, 365);
  aiInteger(limit, "top-performer limit", 1, 25);
  aiInteger(minRecipients, "top-performer minimum recipients", 1);
  return api
    .get<unknown>("/api/v1/ai/subject-lines/top-performers", {
      query: {
        days,
        limit,
        min_recipients: minRecipients,
      },
      signal: input.signal,
    })
    .then(parseTopPerformingSubjects);
}

export function askAnalytics(
  question: string,
): Promise<AiOutcome<AnalyticsAnswer>> {
  const normalizedQuestion = validateAiInput(question, "Question", 1, 1_000);
  return call(async () =>
    parseAnalyticsAnswer(
      await api.post<unknown>(
        "/api/v1/analytics/nlq",
        { question: normalizedQuestion },
        AI_CALL_OPTIONS,
      ),
    ),
  );
}

export function getAnomalyBrief(input: {
  metric: AnomalyMetric;
  windowDays: number;
  context?: string;
}): Promise<AiOutcome<AnomalyBriefResult>> {
  const metric = parseAnomalyMetric(input.metric);
  aiInteger(input.windowDays, "anomaly window", 1, 90);
  const context = input.context?.trim() ?? "";
  if (context.length > 4_000) throw new Error("Context is too long.");
  return call(async () =>
    parseAnomalyBrief(
      await api.post<unknown>(
        "/api/v1/analytics/anomaly-brief",
        {
          metric,
          window_days: input.windowDays,
          ...(context ? { context } : {}),
        },
        AI_CALL_OPTIONS,
      ),
    ),
  );
}

export function checkVoiceDrift(
  text: string,
): Promise<AiOutcome<VoiceDriftReading>> {
  const normalizedText = validateAiInput(text, "Voice sample", 1, AI_BODY_MAX);
  return call(async () =>
    parseVoiceDriftReading(
      await api.post<unknown>(
        "/api/v1/voice/drift",
        { text: normalizedText },
        AI_CALL_OPTIONS,
      ),
    ),
  );
}

/**
 * What a UI may honestly say when an AI call comes back unavailable.
 *
 * Deliberately does NOT name a remedy. The server returns the same code
 * whether no credential is configured or the provider is down, so telling
 * someone to add an API key could send them to change a setting that is
 * already correct.
 */
export const AI_UNAVAILABLE_MESSAGE =
  "AI features are not responding for this workspace. Moosewave cannot tell " +
  "from here whether no provider key is configured or the provider itself is " +
  "unreachable — both report the same error.";

/**
 * The pre-send voice-drift reading, typed.
 *
 * `checkVoiceDrift` above collapses every failure into `unavailable`, which is
 * the right shape for the AI Assist scratchpad (it runs six calls and reports
 * "worked / didn't"). The send-confirmation banner needs more than that: it has
 * to tell "the voice service is not configured" apart from "the check ran and
 * your copy is off-brand", and it has to render the score. So this one hands
 * the `ApiError` back to the caller rather than swallowing it.
 *
 * Field names mirror the Go handler's proxy body (apps/api/main.go — it maps
 * `html`/`text` onto the `body` the scorer reads) and the response shape is the
 * one already published in packages/sdk-ts/src/resources/voice-drift.ts.
 */
export interface VoiceDriftReading {
  score: number;
  severity: "ok" | "warn" | "critical";
  reason?: string;
  components?: Record<string, number>;
  suggestions?: string[];
  profileId?: string;
  authoredAdjustment?: number;
}

export function parseVoiceDriftReading(value: unknown): VoiceDriftReading {
  const root = aiRecord(value, "voice drift");
  if (
    root.severity !== "ok" &&
    root.severity !== "warn" &&
    root.severity !== "critical"
  ) {
    throw new Error("Invalid voice drift severity");
  }
  let components: Record<string, number> | undefined;
  // The deployed voice service names this object `breakdown`; the public SDK
  // historically called it `components`. Accept both during the contract
  // migration, but normalize to one UI shape and reject conflicting values.
  if (root.components !== undefined && root.breakdown !== undefined) {
    throw new Error("Ambiguous voice drift component breakdown");
  }
  const rawComponents = root.components ?? root.breakdown;
  if (rawComponents !== undefined) {
    const source = aiRecord(rawComponents, "voice drift components");
    const entries = Object.entries(source);
    if (
      entries.length > 50 ||
      entries.some(([key]) => !/^[a-z][a-z0-9_-]{0,63}$/iu.test(key))
    ) {
      throw new Error("Invalid voice drift components");
    }
    components = Object.fromEntries(
      entries.map(([key, component]) => [
        key,
        aiNumber(component, "voice drift component", -100, 100),
      ]),
    );
  }
  return {
    score: aiNumber(root.score, "voice drift score", 0, 100),
    severity: root.severity,
    ...(root.reason === undefined
      ? {}
      : { reason: aiText(root.reason, "voice drift reason", 4_000, true) }),
    ...(components ? { components } : {}),
    ...(root.suggestions === undefined
      ? {}
      : {
          suggestions: aiStringList(
            root.suggestions,
            "voice drift suggestions",
            20,
            2_000,
          ),
        }),
    ...(root.profile_id === undefined
      ? {}
      : {
          profileId: aiText(
            root.profile_id,
            "voice drift profile identity",
            128,
          ),
        }),
    ...(root.authored_adjustment === undefined
      ? {}
      : {
          authoredAdjustment: aiNumber(
            root.authored_adjustment,
            "voice drift authored adjustment",
            -100,
            100,
          ),
        }),
  };
}

export interface VoiceDriftInput {
  html?: string;
  text?: string;
  profileId?: string;
}

export interface VoiceDriftRequestBody {
  html?: string;
  text?: string;
  profile_id?: string;
}

/**
 * Build the exact body the gateway will score.
 *
 * The gateway gives non-empty `html` precedence over `text`. Mirror that rule
 * here so a whitespace-only HTML field cannot mask a real plain-text body, and
 * so the query key can be made from the same effective input as the request.
 * Empty optional fields are omitted instead of being sent as misleading
 * values. The selected content itself is preserved byte-for-byte.
 */
export function buildVoiceDriftRequest(
  input: VoiceDriftInput,
): VoiceDriftRequestBody | null {
  const html = input.html?.trim() ? input.html : undefined;
  const text = !html && input.text?.trim() ? input.text : undefined;
  if (!html && !text) return null;

  const profileId = input.profileId?.trim();
  return {
    ...(html ? { html } : { text }),
    ...(profileId ? { profile_id: profileId } : {}),
  };
}

export function getVoiceDriftReading(
  input: VoiceDriftInput,
  options?: { signal?: AbortSignal },
): Promise<VoiceDriftReading> {
  const body = buildVoiceDriftRequest(input);
  if (!body) {
    return Promise.reject(
      new Error("Voice drift requires a non-empty HTML or plain-text body."),
    );
  }
  return api
    .post<unknown>("/api/v1/voice/drift", body, options)
    .then(parseVoiceDriftReading);
}
