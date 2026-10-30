/**
 * Stand-in for `@sentry-internal/feedback` on iOS/Android.
 *
 * That package is Sentry's DOM user-feedback widget: it builds an HTML dialog,
 * takes a canvas screenshot, and attaches to `document`. None of it can run on
 * Hermes, and @sentry/react-native ships its OWN native feedback surface
 * (`dist/js/feedback/FeedbackWidget`), which does not import this package at
 * all. It reaches the bundle only through @sentry/browser's barrel, and it is
 * one pre-bundled 78,103-byte module that survives tree shaking.
 *
 * WHY THIS IS A REAL MODULE AND NOT `{ type: "empty" }`.
 * `@sentry/browser/feedbackAsync.js` and `feedbackSync.js` call
 * `buildFeedbackIntegration({...})` at MODULE SCOPE, and both are in the
 * bundle. An empty module makes that binding `undefined`, and the call throws
 * `TypeError` the instant either module is evaluated — a crash at startup, not
 * a lazy failure. Metro resolves an empty module happily, so a successful
 * export would NOT have caught it.
 *
 * So the shim satisfies the shape those two call sites need: a factory that
 * returns an integration factory, plus the two integrations they pass through
 * and the two helpers the barrel re-exports.
 *
 * The integrations are inert. Nothing installs them: `getDefaultIntegrations`
 * in @sentry/react-native does not include feedback, and no app code calls any
 * feedback API (`sentryFeedbackStub.test.ts` fails the build if that changes).
 */

/** The shape Sentry expects back from an integration factory. */
function noopFeedbackIntegration() {
  return {
    name: "PostwaveNoopFeedback",
    setupOnce() {},
    setup() {},
  };
}

/**
 * `buildFeedbackIntegration(options)` returns the integration FACTORY, which
 * the caller then exports. It is never invoked on native.
 */
function buildFeedbackIntegration() {
  return noopFeedbackIntegration;
}

function getFeedback() {
  return undefined;
}

function sendFeedback() {
  return Promise.resolve(undefined);
}

module.exports = {
  buildFeedbackIntegration,
  feedbackModalIntegration: noopFeedbackIntegration,
  feedbackScreenshotIntegration: noopFeedbackIntegration,
  getFeedback,
  sendFeedback,
};
