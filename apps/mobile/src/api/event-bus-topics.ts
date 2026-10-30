import { isValidEventTopicFilter } from "@postwave/query-contract";

const DEFAULT_EVENT_BUS_TOPICS = ["*"];
const MAX_EVENT_BUS_TOPICS = 50;
const MAX_EVENT_BUS_TOPICS_CSV_CHARS = 1024;
// The topic grammar is NOT re-declared here. It lives in
// @postwave/query-contract (`isValidEventTopicFilter`, mirroring the gateway's
// streamTopicRE) because a local copy is exactly how this drifted: three
// hand-maintained regexes all omitted `_` while the gateway published
// `list_health.degraded`, `subscriber.engagement_updated` and
// `subscriber.lifecycle_stage_changed`. Every filter naming one of those was
// dropped here, silently, before the request was ever sent.

export function normalizeEventBusTopics(topics: string[]): string {
  const out: string[] = [];
  for (const raw of topics) {
    if (out.length >= MAX_EVENT_BUS_TOPICS) break;
    const topic = String(raw ?? "").trim();
    if (!topic || !isValidEventTopicFilter(topic)) continue;
    if (!out.includes(topic)) out.push(topic);
  }
  const csv = (out.length > 0 ? out : DEFAULT_EVENT_BUS_TOPICS).join(",");
  if (csv.length > MAX_EVENT_BUS_TOPICS_CSV_CHARS) {
    return DEFAULT_EVENT_BUS_TOPICS.join(",");
  }
  return csv;
}
