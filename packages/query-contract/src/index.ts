/**
 * @postwave/query-contract — the canonical TanStack Query key factory +
 * staleness table shared across web/desktop (and adaptable by mobile), so
 * cache key shape can't drift between clients.
 */

export {
  type RoleKey,
  type QueryKeyFactory,
  STALE,
  base,
  qk,
} from "./keys.js";

export {
  type CanonicalResource,
  type EventDomain,
  CANONICAL_RESOURCES,
  EVENT_DOMAINS,
  EVENT_TOPIC_FILTER_PATTERN,
  eventDomain,
  canonicalResourcesForEvent,
  isInvalidatingTopic,
  isValidEventTopicFilter,
  usableEventTopicFilters,
  MAX_EVENT_TOPIC_FILTERS,
  MAX_EVENT_TOPICS_CSV_CHARS,
} from "./events.js";

export {
  type ReplayCursor,
  type ReplayPage,
  EMPTY_REPLAY_CURSOR,
  REPLAY_PATH,
  advanceReplayCursor,
  parseReplayResponse,
  replayRequestPath,
} from "./replay.js";
