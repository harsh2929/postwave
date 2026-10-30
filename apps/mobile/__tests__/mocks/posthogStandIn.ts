/**
 * A counting stand-in for PostHog's client, for vitest suites that need to
 * know whether `src/lib/telemetry.ts` BUILT a client, not merely whether it
 * sent anything. The constructor is the consent boundary there: it persists an
 * install id and phones home on its own, so "never constructed" is the claim
 * worth pinning.
 *
 * It lives here rather than beside its caller on purpose.
 * src/lib/posthogEntryPoint.test.ts pins the files under src/ and app/ that
 * name the package to exactly one — the telemetry facade, the only bundle
 * importer the metro redirect was checked against. A test's stand-in is never
 * bundled, so it stays out of that scan instead of widening it.
 *
 * `vi.doMock` is not hoisted and survives `vi.resetModules()`, so a call made
 * before the facade's lazy `import()` runs is the one that import sees.
 */
import { vi } from "vitest";

export interface PostHogStandIn {
  /** One entry per `new PostHog(key, options)`. */
  readonly constructed: { key: string; options: unknown }[];
  /**
   * Every call made on a built client, in order: "optIn", "optOut", "reset",
   * or the verb and its first argument ("capture mobile.tab_viewed").
   */
  readonly calls: string[];
  /**
   * With `holdImport`, the facade's `import()` of the package waits here:
   * `reached` once it has been asked for, `release()` to let it load.
   */
  readonly heldImport: { reached: boolean; release(): void };
  /** Removes the stand-in so later imports see the real module again. */
  release(): void;
}

const MODULE = "posthog-react-native";

export function standInForPostHog(
  options: { holdImport?: boolean } = {},
): PostHogStandIn {
  const constructed: { key: string; options: unknown }[] = [];
  const calls: string[] = [];
  let openImport: () => void = () => {};
  const importGate = new Promise<void>((resolve) => {
    openImport = resolve;
  });
  const heldImport = { reached: false, release: () => openImport() };
  const standIn = () => ({
    PostHog: class {
      constructor(key: string, options?: unknown) {
        constructed.push({ key, options });
      }
      async capture(event: string): Promise<void> {
        calls.push(`capture ${event}`);
      }
      async identify(distinctId: string): Promise<void> {
        calls.push(`identify ${distinctId}`);
      }
      async reset(): Promise<void> {
        calls.push("reset");
      }
      async optIn(): Promise<void> {
        calls.push("optIn");
      }
      async optOut(): Promise<void> {
        calls.push("optOut");
      }
    },
  });
  vi.doMock(
    MODULE,
    options.holdImport
      ? async () => {
          heldImport.reached = true;
          await importGate;
          return standIn();
        }
      : standIn,
  );
  return {
    constructed,
    calls,
    heldImport,
    release: () => {
      heldImport.release();
      vi.doUnmock(MODULE);
    },
  };
}
