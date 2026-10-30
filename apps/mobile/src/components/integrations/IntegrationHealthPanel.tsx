/**
 * IntegrationHealthPanel — what an expanded integration card shows once the
 * health report lands.
 *
 * THE QUESTION THIS ANSWERS. The list says "failing". The card's own
 * `last_error` says WHAT failed. Neither says whether the platform is still
 * retrying, how many times it already has, or when it last managed a clean
 * run — so the honest next step from a phone used to be "open a laptop". The
 * health endpoint carries all three and mobile was not asking for it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. No "retry sync" button. The sync/pause/
 * backfill routes are mounted but resolve to a delegated descriptor rather
 * than an action (see `api/integrations.ts`), and a button that returns 200
 * and changes nothing is worse than no button. The web-admin hand-off on the
 * card is the real action; this panel exists to tell you whether you need it.
 *
 * A11Y. Each attempt row is ONE accessible element carrying a whole spoken
 * sentence (`syncAttemptSpoken`) rather than four loose fragments, status is
 * carried by a labelled Pill and not by colour alone, and the relative ages on
 * screen are paired with absolute timestamps in the spoken label — "2h ago" is
 * for the eye, "25 July 2026 at 16:05" is what you read out on a call.
 *
 * NativeWind v4: static style objects only.
 */
import { Text, View } from "react-native";

import { Pill, type PillTone } from "@/components/Pill";
import { Skeleton, SkeletonGroup } from "@/components/Skeleton";
import { dateTime, relativeTime } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import {
  isEmptyHealth,
  retryPolicySummary,
  syncAttemptSpoken,
  type HealthSeverity,
  type IntegrationHealth,
} from "@/lib/integrationHealth";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface IntegrationHealthPanelProps {
  name: string;
  health: IntegrationHealth | undefined;
  loading: boolean;
  failed: boolean;
  /** False offline: the panel says so instead of claiming there is nothing. */
  online: boolean;
}

function severityTone(state: HealthSeverity): PillTone {
  if (state === "ok") return "success";
  if (state === "error") return "danger";
  if (state === "warning") return "warning";
  return "neutral";
}

/** Sync outcomes the server reports, mapped without ever guessing "success". */
function attemptTone(status: string): PillTone {
  const s = status.toLowerCase();
  if (s === "ok" || s === "success" || s === "succeeded") return "success";
  if (s === "failed" || s === "error" || s === "dead_letter") return "danger";
  if (s === "retrying" || s === "pending" || s === "running") return "info";
  return "neutral";
}

export function IntegrationHealthPanel({
  name,
  health,
  loading,
  failed,
  online,
}: IntegrationHealthPanelProps) {
  const { t } = useTheme();

  if (loading) {
    return (
      <SkeletonGroup label={`Loading ${name} health`}>
        <View style={{ gap: 8 }}>
          <Skeleton width="45%" height={typeStyle("caption").fontSize} />
          <Skeleton width="80%" height={typeStyle("label").fontSize} />
          <Skeleton width="65%" height={typeStyle("label").fontSize} />
        </View>
      </SkeletonGroup>
    );
  }

  if (!online) {
    return <Note text="Health checks need a connection. Reconnect and pull to refresh." />;
  }

  if (failed) {
    // Never render "no checks" for a fetch that failed — that is the
    // error-as-empty bug the whole screen exists to avoid.
    return (
      <Note
        tone="warning"
        text="Couldn't load the health report. Pull to refresh."
      />
    );
  }

  if (!health) return null;
  // The null check guards the PARENT, not its array field: `omitempty` drops
  // an empty slice and `.length`/`.map` then throw on a payload the server
  // considers valid.
  const checks = Array.isArray(health.checks) ? health.checks : [];

  if (isEmptyHealth(health)) {
    return <Note text="This connection reports no health checks or sync history." />;
  }

  const retry = retryPolicySummary(health.retryPolicy);

  return (
    <View style={{ gap: 12 }}>
      {checks.length > 0 ? (
        <View style={{ gap: 8 }}>
          <SubLabel>Checks</SubLabel>
          {checks.map((check) => (
            <View
              key={check.key}
              accessible
              accessibilityLabel={`${check.label}: ${check.state}. ${check.message}`}
              style={{ gap: 4 }}
            >
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                  flexWrap: "wrap",
                }}
              >
                <Text
                  {...typeCap("label")}
                  style={{
                    color: t.fg,
                    ...typeStyle("label"),
                    fontWeight: "600",
                    fontFamily: FONT.semibold,
                    flexShrink: 1,
                  }}
                >
                  {check.label}
                </Text>
                <Pill label={check.state} tone={severityTone(check.state)} />
              </View>
              {check.message ? (
                <Text
                  {...typeCap("caption")}
                  style={{
                    color: t.fgSubtle,
                    ...typeStyle("caption"),
                    fontFamily: FONT.regular,
                  }}
                >
                  {check.message}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}

      {health.syncHistory.length > 0 ? (
        <View style={{ gap: 8 }}>
          <SubLabel>Recent attempts</SubLabel>
          {health.syncHistory.map((attempt, index) => {
            const rel = relativeTime(attempt.at, { fallback: "" });
            const abs = dateTime(attempt.at, "");
            return (
              <View
                key={`${attempt.action}-${attempt.at}-${index}`}
                accessible
                accessibilityLabel={syncAttemptSpoken(attempt, abs)}
                style={{ gap: 4 }}
              >
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 6,
                    flexWrap: "wrap",
                  }}
                >
                  <Pill
                    label={attempt.status}
                    tone={attemptTone(attempt.status)}
                  />
                  <Text
                    {...typeCap("label")}
                    style={{
                      color: t.fg,
                      ...typeStyle("label"),
                      fontFamily: FONT.regular,
                      flexShrink: 1,
                    }}
                  >
                    {attempt.action}
                  </Text>
                  {rel ? (
                    <Text
                      {...typeCap("numeric")}
                      style={{
                        color: t.fgSubtle,
                        ...typeStyle("numeric"),
                        fontVariant: ["tabular-nums"],
                        fontFamily: FONT.regular,
                      }}
                    >
                      {rel}
                    </Text>
                  ) : null}
                  {attempt.attempts > 1 ? (
                    <Text
                      {...typeCap("numeric")}
                      style={{
                        color: t.fgSubtle,
                        ...typeStyle("numeric"),
                        fontVariant: ["tabular-nums"],
                        fontFamily: FONT.regular,
                      }}
                    >
                      {`×${attempt.attempts}`}
                    </Text>
                  ) : null}
                </View>
                {attempt.error || attempt.message ? (
                  <Text
                    {...typeCap("caption")}
                    style={{
                      color: attempt.error ? t.danger : t.fgSubtle,
                      ...typeStyle("caption"),
                      fontFamily: FONT.regular,
                    }}
                  >
                    {attempt.error || attempt.message}
                  </Text>
                ) : null}
              </View>
            );
          })}
        </View>
      ) : null}

      {retry ? (
        <View accessible accessibilityLabel={`Retry policy: ${retry}`}>
          <SubLabel>Retries</SubLabel>
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
            }}
          >
            {retry}
          </Text>
        </View>
      ) : null}

      {health.monitoringSurface ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {`Monitored on ${health.monitoringSurface}.`}
        </Text>
      ) : null}
    </View>
  );
}

function SubLabel({ children }: { children: string }) {
  const { t } = useTheme();
  return (
    <Text
      accessibilityRole="header"
      {...typeCap("caption")}
      style={{
        color: t.fgSubtle,
        ...typeStyle("caption"),
        fontWeight: "600",
        fontFamily: FONT.semibold,
        textTransform: "uppercase",
        letterSpacing: 0.5,
      }}
    >
      {children}
    </Text>
  );
}

function Note({ text, tone }: { text: string; tone?: "warning" }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("label")}
      style={{
        color: tone === "warning" ? t.warning : t.fgSubtle,
        ...typeStyle("label"),
        fontFamily: FONT.regular,
      }}
    >
      {text}
    </Text>
  );
}
