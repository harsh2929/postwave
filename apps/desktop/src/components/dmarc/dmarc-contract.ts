import type {
  DmarcDailyPoint,
  DmarcInsights,
  DmarcReport,
  DmarcReportsResponse,
  DmarcSource,
  DmarcSourceDetail,
  DmarcSourcePerReport,
  DmarcSuggestion,
} from "../../lib/api-client";

export const DMARC_REPORT_LIMIT = 500;
export const DMARC_SOURCE_REPORT_LIMIT = 200;
const MAX_DOMAINS = 500;
const MAX_SOURCES = 10;
const MAX_SUGGESTIONS = 8;
const MAX_SERIES_POINTS = 366;
const MAX_SAFE_COUNT = Number.MAX_SAFE_INTEGER;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/u;
const SUGGESTION_CODES = new Set([
  "alignment_low",
  "no_observed_messages",
  "no_reports",
  "policy_action_volume_high",
  "policy_action_volume_low",
  "spf_only_alignment",
]);
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const POLICY = new Set(["", "none", "quarantine", "reject", "unknown"]);
const DISPOSITION = new Set(["none", "quarantine", "reject", "unknown"]);
const SEVERITY = new Set(["info", "warning", "action"]);

export type DmarcRange = "7d" | "30d" | "90d" | "365d";
export type DmarcWorkspace = "overview" | "sources" | "reports";
export type DmarcReportFilter = "all" | "aligned" | "failed";

export const DMARC_RANGES: ReadonlyArray<{
  value: DmarcRange;
  days: number;
  label: string;
}> = [
  { value: "7d", days: 7, label: "7 days" },
  { value: "30d", days: 30, label: "30 days" },
  { value: "90d", days: 90, label: "90 days" },
  { value: "365d", days: 365, label: "Maximum · 1 year" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowlist = new Set(allowed);
  return Object.keys(value).every((key) => allowlist.has(key));
}

function text(
  value: unknown,
  maximum: number,
  allowEmpty = false,
): string | null {
  if (typeof value !== "string" || value.length > maximum) return null;
  if (
    (!allowEmpty && value.length === 0) ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return null;
  }
  return value;
}

function count(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_SAFE_COUNT
    ? value
    : null;
}

function integerIn(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : null;
}

function ratio(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
    ? value
    : null;
}

function timestamp(value: unknown): string | null {
  const candidate = text(value, 64);
  const match = candidate?.match(RFC3339);
  if (!candidate || !match) return null;
  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw, zone] =
    match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);
  const offsetHour = zone === "Z" ? 0 : Number(zone?.slice(1, 3));
  const offsetMinute = zone === "Z" ? 0 : Number(zone?.slice(4, 6));
  if (
    year < 1970 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59 ||
    Number.isNaN(Date.parse(candidate))
  ) {
    return null;
  }
  return candidate;
}

function calendarDay(value: unknown): string | null {
  const candidate = text(value, 10);
  if (!candidate || !DAY.test(candidate)) return null;
  const [yearRaw, monthRaw, dayRaw] = candidate.split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  return year >= 1970 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
    ? candidate
    : null;
}

function hostname(value: unknown, allowEmpty = false): string | null {
  const candidate = text(value, 253, allowEmpty)?.toLowerCase();
  if (candidate === "" && allowEmpty) return candidate;
  if (!candidate || candidate.endsWith(".") || candidate.includes(".."))
    return null;
  const labels = candidate.split(".");
  return labels.every(
    (label) =>
      label.length > 0 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
  )
    ? candidate
    : null;
}

function ipAddress(value: unknown): string | null {
  const candidate = text(value, 45);
  if (!candidate) return null;
  if (!candidate.includes(":")) {
    const octets = candidate.split(".");
    if (
      octets.length !== 4 ||
      octets.some(
        (octet) =>
          !/^\d{1,3}$/u.test(octet) ||
          Number(octet) > 255 ||
          (octet.length > 1 && octet.startsWith("0")),
      )
    ) {
      return null;
    }
    return candidate;
  }
  if (candidate.includes("%") || !/^[0-9a-f:.]+$/iu.test(candidate))
    return null;
  try {
    const parsed = new URL(`http://[${candidate}]/`);
    return parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")
      ? candidate
      : null;
  } catch {
    return null;
  }
}

function closeRatio(
  actual: number,
  numerator: number,
  denominator: number,
): boolean {
  const expected = denominator === 0 ? 0 : numerator / denominator;
  return Math.abs(actual - expected) <= 0.000_001;
}

function parseReport(value: unknown): DmarcReport | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "id",
      "orgName",
      "reportId",
      "domain",
      "policyP",
      "policyPct",
      "dateBegin",
      "dateEnd",
      "passCount",
      "failCount",
      "receivedAt",
    ])
  ) {
    return null;
  }
  const id = text(value["id"], 64);
  const orgName = text(value["orgName"], 256);
  const reportId = text(value["reportId"], 512);
  const domain = hostname(value["domain"]);
  const policyP = text(value["policyP"], 16, true);
  const policyPct =
    value["policyPct"] === null ? null : integerIn(value["policyPct"], 0, 100);
  const dateBegin = timestamp(value["dateBegin"]);
  const dateEnd = timestamp(value["dateEnd"]);
  const passCount = count(value["passCount"]);
  const failCount = count(value["failCount"]);
  const receivedAt = timestamp(value["receivedAt"]);
  if (
    !id ||
    !UUID.test(id) ||
    !orgName ||
    !reportId ||
    !domain ||
    policyP === null ||
    !POLICY.has(policyP) ||
    (value["policyPct"] !== null && policyPct === null) ||
    !dateBegin ||
    !dateEnd ||
    Date.parse(dateBegin) > Date.parse(dateEnd) ||
    passCount === null ||
    failCount === null ||
    passCount + failCount > MAX_SAFE_COUNT ||
    !receivedAt
  ) {
    return null;
  }
  return {
    id,
    orgName,
    reportId,
    domain,
    policyP: policyP as DmarcReport["policyP"],
    policyPct,
    dateBegin,
    dateEnd,
    passCount,
    failCount,
    receivedAt,
  };
}

export function parseDmarcReports(
  value: unknown,
  expected?: {
    domain?: string;
    from?: string;
    to?: string;
    limit?: number;
  },
): DmarcReportsResponse | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["items", "meta"]) ||
    !Array.isArray(value["items"]) ||
    !isRecord(value["meta"])
  ) {
    return null;
  }
  if (value["items"].length > DMARC_REPORT_LIMIT) return null;
  const items = value["items"].map(parseReport);
  if (items.some((item) => item === null)) return null;
  const meta = value["meta"];
  if (
    !hasOnlyKeys(meta, [
      "generatedAt",
      "limit",
      "returned",
      "totalReports",
      "hasMore",
      "availableDomains",
      "domainInventoryTruncated",
      "scope",
    ])
  ) {
    return null;
  }
  const generatedAt = timestamp(meta["generatedAt"]);
  const limit = integerIn(meta["limit"], 1, DMARC_REPORT_LIMIT);
  const returned = count(meta["returned"]);
  const totalReports = count(meta["totalReports"]);
  const availableDomains = meta["availableDomains"];
  const scope = meta["scope"];
  if (
    !generatedAt ||
    limit === null ||
    returned === null ||
    totalReports === null ||
    returned !== items.length ||
    returned > limit ||
    returned !== Math.min(totalReports, limit) ||
    totalReports < returned ||
    typeof meta["hasMore"] !== "boolean" ||
    meta["hasMore"] !== totalReports > returned ||
    !Array.isArray(availableDomains) ||
    availableDomains.length > MAX_DOMAINS ||
    typeof meta["domainInventoryTruncated"] !== "boolean" ||
    !isRecord(scope) ||
    !hasOnlyKeys(scope, ["domain", "from", "to"])
  ) {
    return null;
  }
  const domains = availableDomains.map((candidate) => hostname(candidate));
  if (domains.some((candidate) => candidate === null)) return null;
  const uniqueDomains = domains as string[];
  if (
    new Set(uniqueDomains).size !== uniqueDomains.length ||
    uniqueDomains.some(
      (domain, index) => index > 0 && domain <= uniqueDomains[index - 1]!,
    )
  ) {
    return null;
  }
  const scopeDomain =
    scope["domain"] === undefined ? undefined : hostname(scope["domain"]);
  const scopeFrom =
    scope["from"] === undefined ? undefined : timestamp(scope["from"]);
  const scopeTo =
    scope["to"] === undefined ? undefined : timestamp(scope["to"]);
  if (
    (scope["domain"] !== undefined && !scopeDomain) ||
    (scope["from"] !== undefined && !scopeFrom) ||
    (scope["to"] !== undefined && !scopeTo) ||
    (scopeFrom && scopeTo && Date.parse(scopeFrom) > Date.parse(scopeTo)) ||
    (scopeTo && Date.parse(generatedAt) < Date.parse(scopeTo)) ||
    (scopeDomain && items.some((item) => item?.domain !== scopeDomain)) ||
    (expected?.domain !== undefined &&
      scopeDomain !== hostname(expected.domain)) ||
    (expected !== undefined &&
      expected.domain === undefined &&
      scopeDomain !== undefined) ||
    (expected?.from !== undefined &&
      (!scopeFrom || Date.parse(scopeFrom) !== Date.parse(expected.from))) ||
    (expected !== undefined &&
      expected.from === undefined &&
      scopeFrom !== undefined) ||
    (expected?.to !== undefined &&
      (!scopeTo || Date.parse(scopeTo) !== Date.parse(expected.to))) ||
    (expected !== undefined &&
      expected.to === undefined &&
      scopeTo !== undefined) ||
    (expected?.limit !== undefined && limit !== expected.limit)
  ) {
    return null;
  }
  const parsedItems = items as DmarcReport[];
  if (
    new Set(parsedItems.map((report) => report.id)).size !==
      parsedItems.length ||
    parsedItems.some(
      (report) =>
        (scopeFrom && Date.parse(report.dateEnd) < Date.parse(scopeFrom)) ||
        (scopeTo && Date.parse(report.dateBegin) > Date.parse(scopeTo)) ||
        Date.parse(report.dateEnd) > Date.parse(generatedAt) ||
        Date.parse(report.receivedAt) > Date.parse(generatedAt),
    ) ||
    parsedItems.some((report, index) => {
      if (index === 0) return false;
      const previous = parsedItems[index - 1]!;
      const dateOrder =
        Date.parse(report.dateEnd) - Date.parse(previous.dateEnd);
      return dateOrder > 0 || (dateOrder === 0 && report.id >= previous.id);
    })
  ) {
    return null;
  }
  return {
    items: parsedItems,
    meta: {
      generatedAt,
      limit,
      returned,
      totalReports,
      hasMore: meta["hasMore"],
      availableDomains: uniqueDomains,
      domainInventoryTruncated: meta["domainInventoryTruncated"],
      scope: {
        ...(scopeDomain ? { domain: scopeDomain } : {}),
        ...(scopeFrom ? { from: scopeFrom } : {}),
        ...(scopeTo ? { to: scopeTo } : {}),
      },
    },
  };
}

function parseSource(value: unknown): DmarcSource | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "sourceIp",
      "messages",
      "dkimPass",
      "spfPass",
      "bothPass",
      "alignedPct",
      "primaryDisposition",
      "quarantined",
      "rejected",
      "envelopeFromDomain",
    ])
  ) {
    return null;
  }
  const sourceIp = ipAddress(value["sourceIp"]);
  const messages = count(value["messages"]);
  const dkimPass = count(value["dkimPass"]);
  const spfPass = count(value["spfPass"]);
  const bothPass = count(value["bothPass"]);
  const alignedPct = ratio(value["alignedPct"]);
  const disposition = text(value["primaryDisposition"], 16);
  const quarantined = count(value["quarantined"]);
  const rejected = count(value["rejected"]);
  const envelopeFromDomain =
    value["envelopeFromDomain"] === undefined
      ? undefined
      : hostname(value["envelopeFromDomain"]);
  if (
    !sourceIp ||
    messages === null ||
    dkimPass === null ||
    spfPass === null ||
    bothPass === null ||
    alignedPct === null ||
    !disposition ||
    !DISPOSITION.has(disposition) ||
    quarantined === null ||
    rejected === null ||
    bothPass > dkimPass ||
    bothPass > spfPass ||
    dkimPass + spfPass - bothPass > messages ||
    quarantined + rejected > messages ||
    !closeRatio(alignedPct, dkimPass + spfPass - bothPass, messages) ||
    (value["envelopeFromDomain"] !== undefined && envelopeFromDomain === null)
  ) {
    return null;
  }
  return {
    sourceIp,
    messages,
    dkimPass,
    spfPass,
    bothPass,
    alignedPct,
    primaryDisposition: disposition as DmarcSource["primaryDisposition"],
    quarantined,
    rejected,
    ...(envelopeFromDomain ? { envelopeFromDomain } : {}),
  };
}

function parseSuggestion(value: unknown): DmarcSuggestion | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["code", "severity", "action", "reason"])
  ) {
    return null;
  }
  const code = text(value["code"], 64);
  const severity = text(value["severity"], 16);
  const action = text(value["action"], 512);
  const reason =
    value["reason"] === undefined ? undefined : text(value["reason"], 2_048);
  if (
    !code ||
    !SAFE_CODE.test(code) ||
    !SUGGESTION_CODES.has(code) ||
    !severity ||
    !SEVERITY.has(severity) ||
    !action ||
    (value["reason"] !== undefined && !reason) ||
    value["policyRecord"] !== undefined
  ) {
    return null;
  }
  return {
    code,
    severity: severity as DmarcSuggestion["severity"],
    action,
    ...(reason ? { reason } : {}),
  };
}

function parseSeriesPoint(value: unknown): DmarcDailyPoint | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["date", "messages", "aligned", "alignedPct"])
  ) {
    return null;
  }
  const date = calendarDay(value["date"]);
  const messages = count(value["messages"]);
  const aligned = count(value["aligned"]);
  const alignedPct = ratio(value["alignedPct"]);
  if (
    !date ||
    messages === null ||
    messages === 0 ||
    aligned === null ||
    aligned > messages ||
    alignedPct === null ||
    !closeRatio(alignedPct, aligned, messages)
  ) {
    return null;
  }
  return { date, messages, aligned, alignedPct };
}

export function parseDmarcInsights(
  value: unknown,
  expected?: { domain?: string; days: number },
): DmarcInsights | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "domain",
      "periodDays",
      "generatedAt",
      "windowStart",
      "windowEnd",
      "latestReportAt",
      "reportingDays",
      "reportCount",
      "totalMessages",
      "sourceCount",
      "sourceListTruncated",
      "alignment",
      "disposition",
      "topSources",
      "topFailingSources",
      "suggestions",
      "series",
      "latestPolicy",
    ])
  ) {
    return null;
  }
  const domain = hostname(value["domain"], true);
  const periodDays = integerIn(value["periodDays"], 1, 365);
  const generatedAt = timestamp(value["generatedAt"]);
  const windowStart = timestamp(value["windowStart"]);
  const windowEnd = timestamp(value["windowEnd"]);
  const latestReportAt =
    value["latestReportAt"] === undefined
      ? undefined
      : timestamp(value["latestReportAt"]);
  const reportingDays = count(value["reportingDays"]);
  const reportCount = count(value["reportCount"]);
  const totalMessages = count(value["totalMessages"]);
  const sourceCount = count(value["sourceCount"]);
  if (
    domain === null ||
    periodDays === null ||
    !generatedAt ||
    !windowStart ||
    !windowEnd ||
    Date.parse(windowStart) > Date.parse(windowEnd) ||
    Date.parse(windowEnd) - Date.parse(windowStart) !==
      periodDays * 24 * 60 * 60 * 1_000 ||
    Date.parse(generatedAt) !== Date.parse(windowEnd) ||
    (latestReportAt != null &&
      Date.parse(latestReportAt) > Date.parse(generatedAt)) ||
    (expected !== undefined && periodDays !== expected.days) ||
    (expected !== undefined &&
      domain !== (expected.domain ?? "").toLowerCase()) ||
    (value["latestReportAt"] !== undefined && !latestReportAt) ||
    reportingDays === null ||
    reportingDays > periodDays + 1 ||
    reportCount === null ||
    totalMessages === null ||
    sourceCount === null ||
    typeof value["sourceListTruncated"] !== "boolean" ||
    !isRecord(value["alignment"]) ||
    !hasOnlyKeys(value["alignment"], [
      "bothPass",
      "dkimOnlyPass",
      "spfOnlyPass",
      "neitherPass",
      "alignedPct",
    ]) ||
    !isRecord(value["disposition"]) ||
    !hasOnlyKeys(value["disposition"], [
      "none",
      "quarantine",
      "reject",
      "unknown",
    ]) ||
    !Array.isArray(value["topSources"]) ||
    !Array.isArray(value["topFailingSources"]) ||
    !Array.isArray(value["suggestions"]) ||
    !Array.isArray(value["series"]) ||
    value["topSources"].length > MAX_SOURCES ||
    value["topFailingSources"].length > MAX_SOURCES ||
    value["suggestions"].length > MAX_SUGGESTIONS ||
    value["series"].length > MAX_SERIES_POINTS
  ) {
    return null;
  }
  const alignment = value["alignment"];
  const bothPass = count(alignment["bothPass"]);
  const dkimOnlyPass = count(alignment["dkimOnlyPass"]);
  const spfOnlyPass = count(alignment["spfOnlyPass"]);
  const neitherPass = count(alignment["neitherPass"]);
  const alignedPct = ratio(alignment["alignedPct"]);
  const disposition = value["disposition"];
  const none = count(disposition["none"]);
  const quarantine = count(disposition["quarantine"]);
  const reject = count(disposition["reject"]);
  const unknown = count(disposition["unknown"]);
  if (
    bothPass === null ||
    dkimOnlyPass === null ||
    spfOnlyPass === null ||
    neitherPass === null ||
    alignedPct === null ||
    none === null ||
    quarantine === null ||
    reject === null ||
    unknown === null ||
    bothPass + dkimOnlyPass + spfOnlyPass + neitherPass !== totalMessages ||
    none + quarantine + reject + unknown !== totalMessages ||
    !closeRatio(
      alignedPct,
      bothPass + dkimOnlyPass + spfOnlyPass,
      totalMessages,
    )
  ) {
    return null;
  }
  const topSources = value["topSources"].map(parseSource);
  const topFailingSources = value["topFailingSources"].map(parseSource);
  const suggestions = value["suggestions"].map(parseSuggestion);
  const series = value["series"].map(parseSeriesPoint);
  if (
    topSources.some((source) => source === null) ||
    topFailingSources.some((source) => source === null) ||
    suggestions.some((suggestion) => suggestion === null) ||
    series.some((point) => point === null)
  ) {
    return null;
  }
  const parsedSeries = series as DmarcDailyPoint[];
  const parsedTopSources = topSources as DmarcSource[];
  const parsedTopFailingSources = topFailingSources as DmarcSource[];
  const seriesMessages = parsedSeries.reduce(
    (sum, point) => sum + point.messages,
    0,
  );
  const seriesAligned = parsedSeries.reduce(
    (sum, point) => sum + point.aligned,
    0,
  );
  const visibleSourceMessages = parsedTopSources.reduce(
    (sum, source) => sum + source.messages,
    0,
  );
  if (
    reportingDays !== parsedSeries.length ||
    topSources.length !== Math.min(sourceCount, MAX_SOURCES) ||
    value["sourceListTruncated"] !== sourceCount > MAX_SOURCES ||
    !Number.isSafeInteger(seriesMessages) ||
    !Number.isSafeInteger(seriesAligned) ||
    !Number.isSafeInteger(visibleSourceMessages) ||
    visibleSourceMessages > totalMessages ||
    parsedTopSources.some((source) => source.messages > totalMessages) ||
    parsedTopFailingSources.some(
      (source) =>
        source.messages > totalMessages ||
        source.messages < 20 ||
        source.alignedPct >= 0.8,
    ) ||
    parsedTopSources.some((source) => source.messages === 0) ||
    parsedTopFailingSources.some((source) => source.messages === 0) ||
    seriesMessages !== totalMessages ||
    seriesAligned !== bothPass + dkimOnlyPass + spfOnlyPass ||
    (totalMessages === 0) !== (sourceCount === 0) ||
    (reportCount === 0 &&
      (latestReportAt !== undefined ||
        reportingDays !== 0 ||
        totalMessages !== 0 ||
        sourceCount !== 0)) ||
    (reportCount > 0 && latestReportAt === undefined) ||
    new Set(
      (suggestions as DmarcSuggestion[]).map((suggestion) => suggestion.code),
    ).size !== suggestions.length ||
    new Set(parsedTopSources.map((source) => source.sourceIp)).size !==
      parsedTopSources.length ||
    new Set(parsedTopFailingSources.map((source) => source.sourceIp)).size !==
      parsedTopFailingSources.length ||
    parsedTopSources.some((source, index) => {
      if (index === 0) return false;
      const previous = parsedTopSources[index - 1]!;
      return (
        source.messages > previous.messages ||
        (source.messages === previous.messages &&
          source.sourceIp <= previous.sourceIp)
      );
    }) ||
    parsedTopFailingSources.some((source, index) => {
      if (index === 0) return false;
      const previous = parsedTopFailingSources[index - 1]!;
      const sourceFailures =
        source.messages - source.dkimPass - source.spfPass + source.bothPass;
      const previousFailures =
        previous.messages -
        previous.dkimPass -
        previous.spfPass +
        previous.bothPass;
      return (
        sourceFailures > previousFailures ||
        (sourceFailures === previousFailures &&
          source.sourceIp <= previous.sourceIp)
      );
    }) ||
    parsedSeries.some(
      (point, index) =>
        point.date < windowStart.slice(0, 10) ||
        point.date > windowEnd.slice(0, 10) ||
        (index > 0 && point.date <= parsedSeries[index - 1]!.date),
    )
  ) {
    return null;
  }
  const latestPolicy =
    value["latestPolicy"] === undefined
      ? undefined
      : text(value["latestPolicy"], 16, true);
  if (
    value["latestPolicy"] !== undefined &&
    (!latestPolicy || latestPolicy === "" || !POLICY.has(latestPolicy))
  ) {
    return null;
  }
  if (
    (domain === "" && latestPolicy !== undefined) ||
    (domain !== "" && reportCount > 0 && latestPolicy === undefined) ||
    (reportCount === 0 && latestPolicy !== undefined)
  ) {
    return null;
  }
  return {
    domain,
    periodDays,
    generatedAt,
    windowStart,
    windowEnd,
    ...(latestReportAt ? { latestReportAt } : {}),
    reportingDays,
    reportCount,
    totalMessages,
    sourceCount,
    sourceListTruncated: value["sourceListTruncated"],
    alignment: { bothPass, dkimOnlyPass, spfOnlyPass, neitherPass, alignedPct },
    disposition: { none, quarantine, reject, unknown },
    topSources: parsedTopSources,
    topFailingSources: parsedTopFailingSources,
    suggestions: suggestions as DmarcSuggestion[],
    series: parsedSeries,
    ...(latestPolicy
      ? { latestPolicy: latestPolicy as DmarcInsights["latestPolicy"] }
      : {}),
  };
}

function parseSourceReport(value: unknown): DmarcSourcePerReport | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "reportId",
      "orgName",
      "dateBegin",
      "dateEnd",
      "messages",
      "dkimPass",
      "spfPass",
      "bothPass",
      "alignedPct",
      "primaryDisposition",
    ])
  ) {
    return null;
  }
  const reportId = text(value["reportId"], 64);
  const orgName = text(value["orgName"], 256);
  const dateBegin = timestamp(value["dateBegin"]);
  const dateEnd = timestamp(value["dateEnd"]);
  const messages = count(value["messages"]);
  const dkimPass = count(value["dkimPass"]);
  const spfPass = count(value["spfPass"]);
  const bothPass = count(value["bothPass"]);
  const alignedPct = ratio(value["alignedPct"]);
  const primaryDisposition = text(value["primaryDisposition"], 16);
  if (
    !reportId ||
    !UUID.test(reportId) ||
    !orgName ||
    !dateBegin ||
    !dateEnd ||
    Date.parse(dateBegin) > Date.parse(dateEnd) ||
    messages === null ||
    messages === 0 ||
    dkimPass === null ||
    spfPass === null ||
    bothPass === null ||
    alignedPct === null ||
    !primaryDisposition ||
    !DISPOSITION.has(primaryDisposition) ||
    bothPass > dkimPass ||
    bothPass > spfPass ||
    dkimPass + spfPass - bothPass > messages ||
    !closeRatio(alignedPct, dkimPass + spfPass - bothPass, messages)
  ) {
    return null;
  }
  return {
    reportId,
    orgName,
    dateBegin,
    dateEnd,
    messages,
    dkimPass,
    spfPass,
    bothPass,
    alignedPct,
    primaryDisposition:
      primaryDisposition as DmarcSourcePerReport["primaryDisposition"],
  };
}

export function parseDmarcSourceDetail(
  value: unknown,
  expected: { ip: string; domain?: string; days: number },
): DmarcSourceDetail | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "sourceIp",
      "domain",
      "periodDays",
      "generatedAt",
      "windowStart",
      "windowEnd",
      "hasMore",
      "summary",
      "perReport",
    ])
  ) {
    return null;
  }
  const sourceIp = ipAddress(value["sourceIp"]);
  const expectedIp = ipAddress(expected.ip);
  const periodDays = integerIn(value["periodDays"], 1, 365);
  const domain =
    value["domain"] === undefined ? undefined : hostname(value["domain"], true);
  const generatedAt = timestamp(value["generatedAt"]);
  const windowStart = timestamp(value["windowStart"]);
  const windowEnd = timestamp(value["windowEnd"]);
  const summary = parseSource(value["summary"]);
  const perReport = value["perReport"];
  if (
    !sourceIp ||
    !expectedIp ||
    sourceIp !== expectedIp ||
    periodDays !== expected.days ||
    (value["domain"] !== undefined && domain === null) ||
    (domain ?? "") !== (expected.domain ?? "") ||
    !generatedAt ||
    !windowStart ||
    !windowEnd ||
    Date.parse(windowStart) > Date.parse(windowEnd) ||
    Date.parse(windowEnd) - Date.parse(windowStart) !==
      periodDays * 24 * 60 * 60 * 1_000 ||
    Date.parse(generatedAt) !== Date.parse(windowEnd) ||
    typeof value["hasMore"] !== "boolean" ||
    !summary ||
    summary.sourceIp !== sourceIp ||
    !Array.isArray(perReport) ||
    perReport.length > DMARC_SOURCE_REPORT_LIMIT
  ) {
    return null;
  }
  const reports = perReport.map(parseSourceReport);
  if (reports.some((report) => report === null)) return null;
  const parsed = reports as DmarcSourcePerReport[];
  const perReportTotals = parsed.reduce(
    (totals, report) => ({
      messages: totals.messages + report.messages,
      dkimPass: totals.dkimPass + report.dkimPass,
      spfPass: totals.spfPass + report.spfPass,
      bothPass: totals.bothPass + report.bothPass,
    }),
    { messages: 0, dkimPass: 0, spfPass: 0, bothPass: 0 },
  );
  if (
    new Set(parsed.map((report) => report.reportId)).size !== parsed.length ||
    Object.values(perReportTotals).some(
      (aggregate) => !Number.isSafeInteger(aggregate),
    ) ||
    perReportTotals.messages > summary.messages ||
    perReportTotals.dkimPass > summary.dkimPass ||
    perReportTotals.spfPass > summary.spfPass ||
    perReportTotals.bothPass > summary.bothPass ||
    (value["hasMore"] && parsed.length !== DMARC_SOURCE_REPORT_LIMIT) ||
    (value["hasMore"] && perReportTotals.messages >= summary.messages) ||
    (!value["hasMore"] &&
      (perReportTotals.messages !== summary.messages ||
        perReportTotals.dkimPass !== summary.dkimPass ||
        perReportTotals.spfPass !== summary.spfPass ||
        perReportTotals.bothPass !== summary.bothPass)) ||
    parsed.some(
      (report) =>
        Date.parse(report.dateEnd) < Date.parse(windowStart) ||
        Date.parse(report.dateEnd) > Date.parse(windowEnd),
    ) ||
    parsed.some(
      (report, index) =>
        index > 0 &&
        (Date.parse(report.dateEnd) > Date.parse(parsed[index - 1]!.dateEnd) ||
          (Date.parse(report.dateEnd) ===
            Date.parse(parsed[index - 1]!.dateEnd) &&
            report.reportId >= parsed[index - 1]!.reportId)),
    )
  ) {
    return null;
  }
  return {
    sourceIp,
    periodDays,
    ...(domain ? { domain } : {}),
    generatedAt,
    windowStart,
    windowEnd,
    hasMore: value["hasMore"],
    summary,
    perReport: parsed,
  };
}

export function rangeDays(range: DmarcRange): number {
  return (
    DMARC_RANGES.find((candidate) => candidate.value === range)?.days ?? 30
  );
}

export function rangeStart(range: DmarcRange, now = new Date()): string {
  const start = new Date(
    now.getTime() - rangeDays(range) * 24 * 60 * 60 * 1_000,
  );
  return start.toISOString();
}

/** Neutralize spreadsheet formulas before RFC-4180 quoting. */
export function safeDmarcCsvCell(value: string | number | boolean): string {
  let serialized = String(value);
  if (/^[=+\-@]/u.test(serialized)) serialized = `'${serialized}`;
  if (/[",\n\r]/u.test(serialized)) {
    return `"${serialized.replace(/"/gu, '""')}"`;
  }
  return serialized;
}

export function buildDmarcCsv(
  rows: readonly DmarcReport[],
  receipt: {
    exportedAt: string;
    snapshotGeneratedAt: string;
    scopeDomain: string;
    scopeFrom: string;
    scopeTo: string;
    scopeWindowDays: number;
    localFilter: DmarcReportFilter;
    localQuery: string;
    totalReports: number;
    partial: boolean;
    stale: boolean;
  },
): string {
  const receiptColumns: Array<[string, string | number | boolean]> = [
    ["export_created_at", receipt.exportedAt],
    ["snapshot_generated_at", receipt.snapshotGeneratedAt],
    ["scope_domain", receipt.scopeDomain],
    ["scope_from", receipt.scopeFrom],
    ["scope_to", receipt.scopeTo],
    ["scope_window_days", receipt.scopeWindowDays],
    ["local_filter", receipt.localFilter],
    ["local_query", receipt.localQuery],
    ["scope_total_reports", receipt.totalReports],
    ["partial_export", receipt.partial],
    ["stale_snapshot", receipt.stale],
  ];
  const reportColumns: Array<
    [string, (report: DmarcReport) => string | number]
  > = [
    ["postwave_receipt_id", (report) => report.id],
    ["report_id", (report) => report.reportId],
    ["sending_domain", (report) => report.domain],
    ["reporting_organization", (report) => report.orgName],
    ["observed_policy", (report) => report.policyP || "unknown"],
    ["observed_policy_pct", (report) => report.policyPct ?? ""],
    ["period_begin_utc", (report) => report.dateBegin],
    ["period_end_utc", (report) => report.dateEnd],
    ["aligned_messages", (report) => report.passCount],
    ["unaligned_messages", (report) => report.failCount],
    ["ingested_at", (report) => report.receivedAt],
  ];
  const header = [
    ...receiptColumns.map(([key]) => key),
    ...reportColumns.map(([key]) => key),
  ]
    .map(safeDmarcCsvCell)
    .join(",");
  const lines = rows.map((report) =>
    [
      ...receiptColumns.map(([, value]) => safeDmarcCsvCell(value)),
      ...reportColumns.map(([, getter]) => safeDmarcCsvCell(getter(report))),
    ].join(","),
  );
  return `${header}\n${lines.join("\n")}`;
}

export function filterDmarcReports(
  rows: readonly DmarcReport[],
  filter: DmarcReportFilter,
  query: string,
): DmarcReport[] {
  const needle = query.trim().toLocaleLowerCase().slice(0, 256);
  return rows.filter((report) => {
    if (
      filter === "aligned" &&
      (report.passCount + report.failCount === 0 || report.failCount > 0)
    ) {
      return false;
    }
    if (filter === "failed" && report.failCount === 0) return false;
    return (
      !needle ||
      report.domain.toLocaleLowerCase().includes(needle) ||
      report.orgName.toLocaleLowerCase().includes(needle) ||
      report.reportId.toLocaleLowerCase().includes(needle) ||
      report.id.toLocaleLowerCase().includes(needle)
    );
  });
}
