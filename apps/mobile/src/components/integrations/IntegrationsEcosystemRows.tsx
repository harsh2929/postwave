/**
 * IntegrationsEcosystemRows — the three report bodies for the ecosystem panel.
 *
 * Split from IntegrationsEcosystemPanel so the container owns tab state and
 * query states while these own rendering one report honestly.
 *
 * THE ONE RULE THESE ALL FOLLOW: a number the server did not send renders as
 * an em-dash, never as 0. These are gate reports — "0 blockers" and "the
 * blocker count is unknown" lead to opposite decisions, and every count here
 * arrives as `number | null` from lib/integrationsEcosystem for that reason.
 *
 * Every sentence — check messages, issue remediations, recommendations, stack
 * next-actions, the public claim — is the server's, rendered verbatim.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { EMDASH, num } from "@/lib/format";
import { FONT } from "@/lib/fonts";
import {
  coverageMaturityLabel,
  coverageTargetLine,
  readinessCheckTone,
  readinessChecksByOutcome,
  readinessVerdictLine,
  stackCoverageLine,
  stackStatusLabel,
  stackStatusTone,
  stacksByUrgency,
  type CoverageView,
  type ReadinessView,
  type StacksView,
} from "@/lib/integrationsEcosystem";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

/** Categories and gaps are long lists; a phone reads the head of each. */
const CATEGORY_LIMIT = 8;
const GAP_LIMIT = 6;
const ISSUE_LIMIT = 6;
const STACK_LIMIT = 8;

function Caption({ children }: { children: React.ReactNode }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgMuted,
        ...typeStyle("caption"),
        fontFamily: FONT.regular,
      }}
    >
      {children}
    </Text>
  );
}

function RowTitle({ children }: { children: React.ReactNode }) {
  const { t } = useTheme();
  return (
    <Text
      {...typeCap("body")}
      style={{
        color: t.fg,
        ...typeStyle("body"),
        fontFamily: FONT.semibold,
        flexShrink: 1,
      }}
    >
      {children}
    </Text>
  );
}

function Divided({ children }: { children: React.ReactNode }) {
  const { t } = useTheme();
  return (
    <View
      style={{
        borderTopColor: t.borderSubtle,
        borderTopWidth: 1,
        paddingTop: 10,
        marginTop: 10,
        gap: 4,
      }}
    >
      {children}
    </View>
  );
}

export function CoverageReportBody({ view }: { view: CoverageView }) {
  const categories = view.categories.slice(0, CATEGORY_LIMIT);
  const gaps = view.priorityGaps.slice(0, GAP_LIMIT);
  return (
    <View>
      {view.targets.map((target) => {
        const line = coverageTargetLine(target);
        return (
          <Divided key={target.label}>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              <RowTitle>{target.label}</RowTitle>
              {target.parity === null ? null : (
                <Pill
                  label={target.parity ? "At target" : "Below target"}
                  tone={target.parity ? "success" : "warning"}
                />
              )}
            </View>
            <Caption>{line ?? `${EMDASH} (not reported)`}</Caption>
          </Divided>
        );
      })}
      <Divided>
        <Caption>
          {`Bridge-ready ${view.bridgeReady === null ? EMDASH : num(view.bridgeReady)} · Planned ${view.planned === null ? EMDASH : num(view.planned)} · Available recipes ${view.availableRecipes === null ? EMDASH : num(view.availableRecipes)}`}
        </Caption>
      </Divided>
      {categories.length > 0 ? (
        <Divided>
          <RowTitle>{`Categories (${categories.length} of ${view.categories.length})`}</RowTitle>
          {categories.map((category) => (
            <Caption key={category.key}>
              {`${category.label} — ${category.total === null ? EMDASH : num(category.total)} entries · ${coverageMaturityLabel(category.maturity)}`}
            </Caption>
          ))}
        </Divided>
      ) : null}
      {gaps.length > 0 ? (
        <Divided>
          <RowTitle>{`Priority gaps (${gaps.length} of ${view.priorityGaps.length})`}</RowTitle>
          {gaps.map((gap) => (
            <View key={gap.slug} style={{ gap: 2, marginTop: 4 }}>
              <Caption>{gap.name}</Caption>
              {/* The server writes the reason; it is the whole content of a
                  gap row and paraphrasing it would invent a cause. */}
              {gap.reason ? <Caption>{gap.reason}</Caption> : null}
            </View>
          ))}
        </Divided>
      ) : null}
    </View>
  );
}

export function ReadinessReportBody({ view }: { view: ReadinessView }) {
  const { t } = useTheme();
  const verdict = readinessVerdictLine(view);
  const checks = readinessChecksByOutcome(view);
  const issues = view.issues.slice(0, ISSUE_LIMIT);
  return (
    <View>
      <Divided>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <RowTitle>Release gate</RowTitle>
          {view.ready === null ? (
            <Pill label="Not reported" tone="neutral" />
          ) : (
            <Pill
              label={view.ready ? "Passing" : "Failing"}
              tone={view.ready ? "success" : "danger"}
            />
          )}
        </View>
        {verdict ? <Caption>{verdict}</Caption> : null}
        {view.publicClaim ? (
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgMuted,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
              marginTop: 4,
            }}
          >
            {/* The server's sentence, labelled as what it is: the claim this
                gate currently PERMITS, not a statement of product fact. */}
            {`Claim the gate currently permits: “${view.publicClaim}”`}
          </Text>
        ) : null}
      </Divided>
      {checks.length > 0 ? (
        <Divided>
          <RowTitle>{`Checks (${checks.length})`}</RowTitle>
          {checks.map((check) => (
            <View key={check.key} style={{ gap: 2, marginTop: 6 }}>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                <Caption>{check.label || check.key}</Caption>
                <Pill
                  label={check.state === "pass" ? "Pass" : "Fail"}
                  tone={readinessCheckTone(check)}
                  accessibilityLabel={`${check.label || check.key}: ${check.state === "pass" ? "pass" : `fail, severity ${check.severity || "unspecified"}`}`}
                />
              </View>
              {check.message ? <Caption>{check.message}</Caption> : null}
            </View>
          ))}
        </Divided>
      ) : null}
      {issues.length > 0 ? (
        <Divided>
          <RowTitle>{`Issues (${issues.length} of ${view.issues.length})`}</RowTitle>
          {issues.map((issue, index) => (
            <View key={`${issue.key}:${index}`} style={{ gap: 2, marginTop: 6 }}>
              <Caption>
                {issue.name ? `${issue.name} — ${issue.message}` : issue.message}
              </Caption>
              {issue.remediation ? <Caption>{issue.remediation}</Caption> : null}
            </View>
          ))}
        </Divided>
      ) : null}
      {view.recommendations.length > 0 ? (
        <Divided>
          <RowTitle>Recommendations</RowTitle>
          {view.recommendations.map((line) => (
            <Caption key={line}>{line}</Caption>
          ))}
        </Divided>
      ) : null}
    </View>
  );
}

export function StacksReportBody({ view }: { view: StacksView }) {
  const line = stackCoverageLine(view);
  const stacks = stacksByUrgency(view).slice(0, STACK_LIMIT);
  const gaps = view.highestImpactGaps.slice(0, GAP_LIMIT);
  return (
    <View>
      <Divided>
        <RowTitle>Curated stacks</RowTitle>
        <Caption>{line ?? `${EMDASH} (coverage not reported)`}</Caption>
      </Divided>
      {stacks.map((stack) => (
        <Divided key={stack.key}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <RowTitle>{stack.name}</RowTitle>
            <Pill
              label={stackStatusLabel(stack.status)}
              tone={stackStatusTone(stack.status)}
            />
          </View>
          <Caption>
            {`${stack.requiredCovered === null ? EMDASH : num(stack.requiredCovered)} of ${stack.requiredTotal === null ? EMDASH : num(stack.requiredTotal)} required components${stack.coveragePct === null ? "" : ` · ${stack.coveragePct}%`}`}
          </Caption>
          {stack.summary ? <Caption>{stack.summary}</Caption> : null}
          {stack.nextActions.map((action) => (
            <Caption key={action}>{action}</Caption>
          ))}
        </Divided>
      ))}
      {gaps.length > 0 ? (
        <Divided>
          <RowTitle>{`Highest-impact gaps (${gaps.length} of ${view.highestImpactGaps.length})`}</RowTitle>
          {gaps.map((gap) => (
            <View key={gap.slug} style={{ gap: 2, marginTop: 4 }}>
              <Caption>
                {`${gap.name} — blocks ${gap.stacks === null ? EMDASH : num(gap.stacks)} ${gap.stacks === 1 ? "stack" : "stacks"}`}
              </Caption>
              {gap.reason ? <Caption>{gap.reason}</Caption> : null}
            </View>
          ))}
        </Divided>
      ) : null}
    </View>
  );
}
