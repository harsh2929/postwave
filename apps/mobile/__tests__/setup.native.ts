import { cleanup } from "@testing-library/react-native";
import { afterEach } from "@jest/globals";

import { setFormatLocale } from "@/lib/format";
import { setMessageLocale } from "@/lib/i18n";

// ── LOCALE PIN (TESTS-3) ──────────────────────────────────────────────────
// lib/format hands Intl `undefined` until a locale is set, so without this the
// route suites print in the ICU default of whatever machine runs them (a
// de_DE shell turned five assertions red). An env pin in the jest config
// cannot help: this runner is --runInBand, so every test shares the process
// jest started in, and ICU fixed its default then. The same pairing as
// localization.ts's initLocalization(), so numbers and message plural rules
// agree; setMessageLocale is a no-op until a catalogue is registered.
// __tests__/format-locale-pin.native.test.ts fails if this goes missing.
setFormatLocale("en-US");
setMessageLocale("en-US");

afterEach(async () => {
  await cleanup();
});
