/** @type {import('jest').Config} */
module.exports = {
  preset: "jest-expo",
  rootDir: __dirname,
  testMatch: ["<rootDir>/__tests__/**/*.native.test.ts?(x)"],
  moduleNameMapper: {
    "^expo-router$": "<rootDir>/__tests__/mocks/expoRouter.cjs",
    "^expo-haptics$": "<rootDir>/__tests__/mocks/expoHaptics.cjs",
    "^expo-secure-store$": "<rootDir>/__tests__/mocks/expoSecureStore.cjs",
    "^expo-crypto$": "<rootDir>/__tests__/mocks/expoCrypto.cjs",
    "^@tanstack/react-query$": "<rootDir>/__tests__/mocks/reactQuery.cjs",
    "^@tanstack/react-query-persist-client$":
      "<rootDir>/__tests__/mocks/queryPersist.cjs",
    "^@react-native-async-storage/async-storage$":
      "<rootDir>/__tests__/mocks/asyncStorage.cjs",
    // The three modules COMMERCE#60 carved out of the old catch-all
    // `useOps` are pure query-hook modules (no mutations, no non-hook
    // exports), so the proxy stands in for them exactly as it did for the
    // module they came from. `useInboundWebhookOps` and `useMigrations`
    // are deliberately NOT here: both also export mutations, which the
    // proxy would hand back in the query shape.
    "^@/hooks/(useAgencyOps|useApprovals|useAudit|useAuditSinkOps|useCampaigns|useDebounced|useIntegrations|useIsOnline|useOnlineQueryGate|useScimOps|useSubscribers|useVoice)$":
      "<rootDir>/__tests__/mocks/queryHooks.cjs",
    "^@/store/auth$": "<rootDir>/__tests__/mocks/authStore.cjs",
    "^@/lib/theme$": "<rootDir>/__tests__/mocks/theme.cjs",
    "^@/lib/fonts$": "<rootDir>/__tests__/mocks/fonts.cjs",
    "^@/api/auth$": "<rootDir>/__tests__/mocks/authApi.cjs",
    "^@/api/(client|mobileParity|sdkClient)$":
      "<rootDir>/__tests__/mocks/apiRuntime.cjs",
    "^@/lib/config$": "<rootDir>/__tests__/mocks/config.cjs",
    "^@/components/tour/TourProvider$": "<rootDir>/__tests__/mocks/tour.cjs",
    "^@/components/BiometricGate$": "<rootDir>/__tests__/mocks/passthrough.cjs",
    "^@/components/(OfflineBanner|OfflineMutationFailureBanner)$":
      "<rootDir>/__tests__/mocks/nullComponent.cjs",
    "^@/components/onboarding/BrandedSplash$":
      "<rootDir>/__tests__/mocks/nullComponent.cjs",
    // Heavy canvas/composer COMPONENTS are stubbed, but the sequence-builder's
    // pure wire codec (`types`, `wire`) must resolve for real: the detail
    // screen calls wireToCanvas/countCanvasSteps during render, so stubbing
    // them turns the step count into a null and hides the very behaviour a
    // detail-screen test exists to pin.
    //
    // The campaign GATING MATRIX is exempt for the same reason. Which buttons
    // a campaign offers — and which of them a viewer/offline session may press
    // — is the riskiest decision on the detail screen, and it is spread across
    // three modules (route → CampaignDetailContent → CampaignActionRow, with
    // ActionButton in CampaignDetailControls carrying accessibilityState).
    // Stubbing any of them turns every assertion about it into a test of the
    // stub. Their leaves (summary/performance/insights/preview/progress cards)
    // stay stubbed, so the composition stays cheap.
    "^@/components/(campaigns|sequence-builder)/(?!types$|wire$|CampaignActionRow$|CampaignDetailContent$|CampaignDetailControls$|CampaignAssurancePrimitives$|CampaignAssuranceSendStatus$|CampaignAssuranceOverrideControl$|CampaignPollReceiptsCard$).*$":
      "<rootDir>/__tests__/mocks/nullComponent.cjs",
    "^@/lib/(connectivity|deepLinks|eventCacheSync|offlineMutations|pendingRoute|push|queryClient|secureQueryPersister|sharedInbox|telemetry|widgetData)$":
      "<rootDir>/__tests__/mocks/rootRuntime.cjs",
    // Its OWN stub, not another rootRuntime alias: what the Stores screen
    // publishes to the home-screen widget is asserted behaviour, and
    // rootRuntime's Proxy hands back a new jest.fn() on every property read.
    "^@/lib/widgetCommerce$": "<rootDir>/__tests__/mocks/widgetCommerce.cjs",
    "^@/lib/sentry$": "<rootDir>/__tests__/mocks/sentry.cjs",
    "^expo-font$": "<rootDir>/__tests__/mocks/expoFont.cjs",
    "^expo-linking$": "<rootDir>/__tests__/mocks/expoLinking.cjs",
    "^expo-notifications$": "<rootDir>/__tests__/mocks/expoNotifications.cjs",
    "^expo/fetch$": "<rootDir>/__tests__/mocks/expoFetch.cjs",
    "^react-native-reanimated$":
      "<rootDir>/__tests__/mocks/reactNativeReanimated.cjs",
    "^react-native-gesture-handler$":
      "<rootDir>/__tests__/mocks/gestureHandler.cjs",
    // No native binary in this environment: TemplateRenderedPreview (inside
    // TemplateDetailSheet, which the templates suite renders for real) pulls
    // react-native-webview, whose TurboModule lookup throws at import time.
    // The null-component proxy answers its `WebView` named export.
    "^react-native-webview$": "<rootDir>/__tests__/mocks/nullComponent.cjs",
    "^@postwave/(onboarding-schema|sdk|telemetry)$":
      "<rootDir>/__tests__/mocks/postwavePackages.cjs",
    // route-map RESOLVES FOR REAL, like @postwave/nav. It is a pure entity →
    // path registry with no native dependency, and the blanket mock made every
    // one of its functions a `jest.fn()` returning `undefined` — which is
    // exactly the "mock shape ≠ real shape" failure the house rules warn
    // about: `webPath()` answered undefined, so WebHandoffRow's URL was null,
    // so the row rendered NOTHING on the subscriber/campaign/sequence details
    // and every assertion about the read-only escape hatch passed vacuously.
    "^@postwave/route-map$": "<rootDir>/../../packages/route-map/dist/index.js",
    // query-contract resolves for real for the same reason as route-map: it is
    // a pure key/topic contract with no native dependency, and mocking it would
    // make `isValidEventTopicFilter` answer undefined — silently dropping every
    // topic from the SSE subscription while the tests still passed. That is the
    // precise failure mode the shared grammar exists to prevent.
    "^@postwave/query-contract$":
      "<rootDir>/../../packages/query-contract/dist/index.js",
    "^@postwave/design-tokens$": "<rootDir>/__tests__/mocks/designTokens.cjs",
    "^@postwave/nav$": "<rootDir>/../../packages/nav/dist/index.js",
    // Resolves for real, like route-map/query-contract/nav: it is the shared
    // outbox CONTRACT (replay-status union, attempt budget, terminal-state
    // predicate) with no native dependency. It is only listed because the
    // package ships `exports` and no CommonJS entry, so jest-resolve cannot
    // find it on its own — src/lib/contextEpoch.ts reaches it through
    // api/sdkClient, which every screen with a data hook pulls in, so without
    // this line four route suites fail to load at all.
    "^@postwave/offline-outbox$":
      "<rootDir>/../../packages/offline-outbox/dist/index.js",
    // Same story, same reason: api/sdkClient reaches src/lib/stepUp, which
    // reaches this package, so an unresolvable entry takes down every route
    // suite rather than the step-up screens alone.
    "^@postwave/step-up$": "<rootDir>/../../packages/step-up/dist/index.js",
    "^@postwave/notifications$":
      "<rootDir>/../../packages/notifications/dist/index.js",
    "^@postwave/ai-disclosure$":
      "<rootDir>/../../packages/ai-disclosure/dist/index.js",
    "\\.(css)$": "<rootDir>/__tests__/mocks/style.cjs",
    "^@/(.*)$": "<rootDir>/src/$1",
  },
  // jest-expo's default list leaves every non-allow-listed node_modules
  // package untransformed. The root workspace pins
  // `decode-uri-component@<0.5.0` -> 0.5.0 as a security override, and 0.5.0
  // is ESM-only, so the moment anything reaches
  // @react-navigation/native -> getPathFromState -> query-string ->
  // decode-uri-component, Jest hits a bare `export default` and the whole
  // suite fails to parse. `src/components/ScrollToTop.tsx` is that edge, and
  // app/(tabs)/dashboard.tsx imports it. Transform the package rather than
  // downgrade the override.
  transformIgnorePatterns: [
    "/node_modules/(?!(.pnpm|react-native|@react-native|@react-native-community|expo|@expo|@expo-google-fonts|react-navigation|@react-navigation|@sentry/react-native|native-base|decode-uri-component))",
    "/node_modules/react-native-reanimated/plugin/",
  ],
  setupFilesAfterEnv: ["<rootDir>/__tests__/setup.native.ts"],
  clearMocks: true,
  restoreMocks: true,
  collectCoverageFrom: [
    "app/**/*.{ts,tsx}",
    "src/components/**/*.{ts,tsx}",
    "!**/*.test.{ts,tsx}",
    "!**/*.d.ts",
  ],
  coverageDirectory: "<rootDir>/coverage/routes",
  coverageReporters: ["text", "json-summary", "lcov"],
  coverageThreshold: {
    global: {
      // Initial all-route render floor (2026-07-15): 26.09 / 16.06 /
      // 23.63 / 27.14. These integer floors must only move upward.
      statements: 26,
      branches: 16,
      functions: 23,
      lines: 27,
    },
  },
};
