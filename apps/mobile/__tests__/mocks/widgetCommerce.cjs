/**
 * The App Group boundary for the widget's COMMERCE record.
 *
 * `src/lib/widgetCommerce.ts` reaches ExtensionStorage through
 * `src/lib/widgetData.ts`, which is native-only — so a route render that mounts
 * `useCommerceWidgetMirror` needs this stub to resolve at all. It is a
 * dedicated file rather than another `rootRuntime.cjs` alias because these
 * calls are ASSERTED: what the Stores screen publishes to a home screen is
 * behaviour, not plumbing, and a Proxy that mints a fresh `jest.fn()` on every
 * property read cannot be asserted against.
 *
 * `writeCommerceWidgetSnapshot` returns null — the real one returns the record
 * it wrote, or null when nothing was published (no consent, no App Group). Null
 * is the shape a non-iOS device produces, and it keeps the hook's retry path
 * live so a test cannot pass because the hook believed one write was enough.
 */
module.exports = {
  writeCommerceWidgetSnapshot: jest.fn(() => null),
  clearCommerceWidgetSnapshot: jest.fn(() => true),
  readPublishedCommerceStoreId: jest.fn(() => null),
  readPublishedCommerceStoreLabel: jest.fn(() => null),
};
