/**
 * Shared FlatList tuning for mobile screens that render server-backed rows.
 *
 * These defaults keep the first paint small, batch follow-up row work, and
 * clip off-screen native views so long admin feeds do less work and retain
 * less memory while preserving normal pull-to-refresh / pagination behavior.
 *
 * THE PHANTOM TAP. React Native's default `keyboardShouldPersistTaps` for a
 * scrollable is "never": while the keyboard is up, the first tap anywhere
 * outside the input is swallowed dismissing it. On every screen that pairs a
 * search field with a list — discounts, inbound webhooks, tags, subscribers —
 * that made the first tap on the row you just filtered for do nothing at all.
 * "handled" keeps the keyboard up only long enough for a child that HAS a press
 * handler to receive the tap; a tap on inert background still dismisses it. It
 * lives here rather than per-screen so the behaviour cannot drift again.
 */
export const MOBILE_LIST_PERF_PROPS = {
  initialNumToRender: 10,
  maxToRenderPerBatch: 8,
  updateCellsBatchingPeriod: 50,
  windowSize: 5,
  removeClippedSubviews: true,
  keyboardShouldPersistTaps: "handled",
} as const;

/**
 * SectionList uses the same VirtualizedList tuning knobs, but exposing a
 * separate constant keeps screens honest about which list primitive they use.
 */
export const MOBILE_SECTION_LIST_PERF_PROPS = MOBILE_LIST_PERF_PROPS;
