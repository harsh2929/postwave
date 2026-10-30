/**
 * FlowGraphCheck — "is this flow actually wired up?", answered by the server's
 * own validator.
 *
 * WHY THIS IS ON A READ-ONLY SCREEN. `POST /api/v1/flow-builder/validate` reads
 * as a pre-save check, and mobile saves nothing, which is why it went unused
 * here for as long as this screen has existed. But the validator does not care
 * where the graph is going. It answers the question someone opens a flow on a
 * phone to ask — *why did this stop working?* — with the four faults the
 * picture cannot show: an edge pointing at a deleted node, an entry_id that
 * names nothing, a branch with one leg wired, a step missing a field it needs.
 * The topology above draws what IS there; this says what is WRONG with it.
 *
 * IT IS ON DEMAND, NOT ON RENDER. The route is `write:campaigns`, and a POST
 * fired for every sheet that opens is both wasteful and rude to a rate limit.
 * More importantly the answer means something because it was ASKED for.
 *
 * ROLE. `write:campaigns` sits in `editorWriteScopes` (apikeys/middleware.go),
 * which `sessionRoleAllowsScopes` admits for owner, admin and editor; and
 * routeauth/manifest.json independently floors the same route at
 * `session_minimum_role: "editor"` with `review_status: "reviewed"`. Both
 * sources agree, and the stricter binds either way — so a viewer never sees the
 * button rather than discovering the floor through a 403. This tightens the
 * affordance to match the server; it widens nothing.
 *
 * A FAILED CHECK IS NEVER A VERDICT ON THE FLOW. `flowValidationErrorMessage`
 * separates "the check could not run" from "the graph has problems"; the two
 * render differently and the first never colours the flow.
 *
 * NativeWind v4 gotcha: static Pressable style objects only — a function-style
 * `style={({pressed}) => …}` silently drops layout on this stack.
 */
import { Pressable, Text, View } from "react-native";

import { Pill } from "@/components/Pill";
import { SectionLabel } from "@/components/SectionLabel";
import { FONT } from "@/lib/fonts";
import {
  flowValidationSummary,
  type MobileFlowValidation,
} from "@/lib/flowValidation";
import { plural } from "@/lib/format";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface FlowGraphCheckProps {
  /** False for a viewer session, and for a flow with no steps to check. */
  canCheck: boolean;
  /** False offline: this is a POST, and there is nothing to queue. */
  online: boolean;
  stepCount: number;
  pending: boolean;
  result: MobileFlowValidation | null;
  /** Set when the CHECK failed, already turned into words. Never a verdict. */
  failure: string | null;
  onCheck: () => void;
}

export function FlowGraphCheck({
  canCheck,
  online,
  stepCount,
  pending,
  result,
  failure,
  onCheck,
}: FlowGraphCheckProps) {
  const { t } = useTheme();

  // Nothing to check, and nothing to explain: the sheet already says in words
  // that this flow was created and never built out.
  if (stepCount === 0) return null;

  const summary = result ? flowValidationSummary(result) : null;
  const tone = summary
    ? summary.tone === "danger"
      ? t.danger
      : summary.tone === "warning"
        ? t.warning
        : t.success
    : t.borderSubtle;

  return (
    <View style={{ marginBottom: 20 }}>
      <SectionLabel>Wiring check</SectionLabel>

      {!canCheck ? (
        <Text
          {...typeCap("bodySmall")}
          style={{
            color: t.fgMuted,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
            marginTop: 4,
          }}
        >
          Checking a flow&rsquo;s wiring needs an editor session, so it
          isn&rsquo;t available on this account.
        </Text>
      ) : (
        <>
          <Pressable
            onPress={onCheck}
            disabled={pending || !online}
            accessibilityRole="button"
            accessibilityLabel={
              result
                ? "Check this flow's wiring again"
                : "Check this flow's wiring"
            }
            accessibilityHint={`Sends this flow's ${plural(
              stepCount,
              "step",
            )} to the server's validator and reports what is wrong with it. Nothing is changed.`}
            accessibilityState={{ disabled: pending || !online, busy: pending }}
            style={{
              minHeight: 44,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 12,
              borderWidth: 1,
              borderColor: t.borderSubtle,
              backgroundColor: t.surface,
              paddingHorizontal: 14,
              marginTop: 4,
              opacity: pending || !online ? 0.5 : 1,
            }}
          >
            <Text
              {...typeCap("control")}
              style={{
                color: t.accent,
                ...typeStyle("control"),
                fontFamily: FONT.semibold,
              }}
            >
              {pending
                ? "Checking…"
                : !online
                  ? "Offline — can't check"
                  : result
                    ? "Check again"
                    : "Check this flow's wiring"}
            </Text>
          </Pressable>

          {failure ? (
            <Text
              accessibilityLiveRegion="polite"
              {...typeCap("bodySmall")}
              style={{
                color: t.fgMuted,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
                marginTop: 8,
              }}
            >
              {failure}
            </Text>
          ) : null}

          {summary && result ? (
            <View
              accessibilityLiveRegion="polite"
              style={{
                marginTop: 10,
                borderWidth: 1,
                borderColor: tone,
                borderRadius: 12,
                backgroundColor: t.surface,
                padding: 12,
                gap: 8,
              }}
            >
              <Text
                {...typeCap("callout")}
                style={{
                  color: tone,
                  ...typeStyle("callout"),
                  fontFamily: FONT.semibold,
                }}
              >
                {summary.headline}
              </Text>
              {summary.detail ? (
                <Text
                  {...typeCap("bodySmall")}
                  style={{
                    color: t.fgMuted,
                    ...typeStyle("bodySmall"),
                    fontFamily: FONT.regular,
                  }}
                >
                  {summary.detail}
                </Text>
              ) : null}

              <FindingList
                title="Errors"
                items={result.errors}
                color={t.danger}
              />
              <FindingList
                title="Warnings"
                items={result.graphWarnings}
                color={t.warning}
              />

              {result.runtimeWarningCount > 0 ? (
                // Said ONCE, as a count. `Catalog()` stamps every item
                // "unavailable" while the runtime is contained, so the
                // validator emits this for every node — repeating it per step
                // would bury the two lines above that name a real defect.
                <Pill
                  label={`${plural(result.runtimeWarningCount, "step")} · runtime unavailable`}
                  tone="neutral"
                  accessibilityLabel={`${plural(
                    result.runtimeWarningCount,
                    "step",
                  )} use a type the flow runtime cannot execute today. That is the containment this screen already describes, not a fault in this flow.`}
                />
              ) : null}
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}

/**
 * The validator's own sentences, verbatim.
 *
 * They name node ids and field keys — `node "n4" (send_email): required field
 * "template_id" is missing` — which is exactly the handle someone needs to find
 * the step in the desktop builder. Paraphrasing them into friendlier prose
 * would throw away the only part that is actionable.
 */
function FindingList({
  title,
  items,
  color,
}: {
  title: string;
  items: readonly string[];
  color: string;
}) {
  const { t } = useTheme();
  if (items.length === 0) return null;
  return (
    <View style={{ gap: 4 }}>
      <Text
        {...typeCap("caption")}
        style={{
          color,
          ...typeStyle("caption"),
          fontFamily: FONT.semibold,
          textTransform: "uppercase",
          letterSpacing: 0.4,
        }}
      >
        {title}
      </Text>
      {items.map((item) => (
        <Text
          key={item}
          {...typeCap("bodySmall")}
          style={{
            color: t.fg,
            ...typeStyle("bodySmall"),
            fontFamily: FONT.regular,
          }}
        >
          {item}
        </Text>
      ))}
    </View>
  );
}
