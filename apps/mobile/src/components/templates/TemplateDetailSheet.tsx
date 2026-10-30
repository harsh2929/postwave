/**
 * TemplateDetailSheet — read the design, then start something from it.
 *
 * A sheet rather than a route, for the same reason the review queue uses one:
 * the rhythm is browse → open → decide → next, and a pushed screen charges a
 * navigation animation in each direction. It also keeps this cluster to ONE
 * route file, so the surface costs one tab-layout registration instead of two.
 *
 * IT RE-READS THE TEMPLATE ON OPEN, AND THAT IS NOT REDUNDANT. `Repo.Search`
 * projects `'' AS body_html, '' AS body_mjml` (catalog.go:182), so a catalogue
 * row physically cannot say whether the design contains an email. Only
 * `GET /campaign-templates/{id}` carries the body. Until that read lands the
 * sheet says "Checking the design…" rather than rendering the projection's
 * blank as "this template is empty" — the same distinction ReviewDetailSheet
 * draws for replies, and for the same reason: a missing measurement is not a
 * zero.
 *
 * IT RENDERS THE TAPPED ROW IMMEDIATELY. `template` is the catalogue row and is
 * available at open; `detail` supersedes it a moment later. Waiting would put a
 * spinner between the tap and content the operator has already read.
 *
 * NO EDITOR. There is deliberately no way to change the design here — see the
 * header of app/(tabs)/templates.tsx.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import {
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import { Pill } from "@/components/Pill";
import { TemplateLifecycleAction } from "@/components/templates/TemplateLifecycleAction";
import { TemplateRenderedPreview } from "@/components/templates/TemplateRenderedPreview";
import { TemplateSheetActions } from "@/components/templates/TemplateSheetActions";
import { FONT } from "@/lib/fonts";
import { EMDASH, date, num, percent } from "@/lib/format";
import {
  templateBodyState,
  templateGoalLabel,
  templateOrigin,
  type MobileTemplate,
} from "@/lib/templateCatalog";
import {
  templateActionGate,
  templatePlaceholderNotice,
} from "@/lib/templatePolicy";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface TemplateDetailSheetProps {
  /** The catalogue row that was tapped — available before the detail read. */
  template: MobileTemplate | null;
  /** The single-template read: the only source of the body. */
  detail: MobileTemplate | null;
  detailLoading: boolean;
  detailFailed: boolean;
  onClose: () => void;
  canWrite: boolean;
  online: boolean;
  starting: boolean;
  duplicating: boolean;
  onStartCampaign: (template: MobileTemplate) => void;
  onDuplicate: (template: MobileTemplate) => void;
  /**
   * The reversible lifecycle pair (PATCH /{id}/archive · /{id}/restore, both
   * editor + strong If-Match). Offered only when the DETAIL read has landed:
   * the catalogue projection carries no entity tag (`etag: ""`), and sending
   * a stale or absent tag is a guaranteed 428/412. Optional so read-only
   * embeddings (and older tests) render unchanged.
   */
  onToggleArchived?: ((template: MobileTemplate) => void) | undefined;
  archiveToggling?: boolean | undefined;
}

function bodySentence(props: TemplateDetailSheetProps): string {
  if (props.detailFailed) {
    return "Couldn't check whether this design has an email body — the catalogue list never carries one.";
  }
  switch (templateBodyState(props.detail)) {
    case "present":
      return "Contains an email body, ready to become a draft.";
    case "empty":
      return "This design has no email body yet. A draft made from it would arrive blank.";
    default:
      return props.detailLoading
        ? "Checking the design…"
        : "The design hasn't been read yet.";
  }
}

function Row({ label, value }: { label: string; value: string }) {
  const { t } = useTheme();
  return (
    <View style={{ flexDirection: "row", gap: 12, alignItems: "flex-start" }}>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgSubtle,
          ...typeStyle("label"),
          fontFamily: FONT.regular,
          width: 110,
        }}
      >
        {label}
      </Text>
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fg,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
          flex: 1,
        }}
      >
        {value}
      </Text>
    </View>
  );
}

export function TemplateDetailSheet(props: TemplateDetailSheetProps) {
  const { t } = useTheme();
  const shown = props.detail ?? props.template;
  const gate = templateActionGate(shown);
  const placeholders = shown ? templatePlaceholderNotice(shown) : null;

  return (
    <ReducedMotionModal
      visible={props.template !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <SafeAreaView
        style={{ flex: 1, backgroundColor: t.bg }}
        edges={["top", "bottom"]}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: 16,
            paddingVertical: 10,
            gap: 12,
          }}
        >
          <Text
            numberOfLines={2}
            {...typeCap("title")}
            style={{
              color: t.fg,
              ...typeStyle("title"),
              fontFamily: FONT.semibold,
              flex: 1,
            }}
          >
            {shown?.name ?? "Template"}
          </Text>
          <Pressable
            onPress={props.onClose}
            accessibilityRole="button"
            accessibilityLabel="Close"
            style={{
              minWidth: 44,
              minHeight: 44,
              alignItems: "center",
              justifyContent: "center",
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
              Done
            </Text>
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingBottom: 24,
            gap: 14,
          }}
          keyboardShouldPersistTaps="handled"
        >
          {shown ? (
            <>
              <View
                style={{
                  flexDirection: "row",
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                {shown.goal ? (
                  <Pill label={templateGoalLabel(shown.goal)} tone="info" />
                ) : null}
                {shown.isFeatured ? (
                  <Pill label="Featured" tone="accent" />
                ) : null}
                {shown.archivedAt !== null ? (
                  <Pill
                    label="Archived"
                    tone="neutral"
                    accessibilityLabel="Archived — off the browse shelf, restorable any time"
                  />
                ) : null}
                {gate.allowed ? (
                  <Pill label="Ready to use" tone="success" />
                ) : (
                  <Pill
                    label={gate.badge}
                    tone="warning"
                    accessibilityLabel={gate.message}
                  />
                )}
              </View>

              <Text
                {...typeCap("body")}
                style={{
                  color: t.fgMuted,
                  ...typeStyle("body"),
                  fontFamily: FONT.regular,
                }}
              >
                {bodySentence(props)}
              </Text>

              {/* The design ITSELF, once the detail read lands — the
                  catalogue row physically cannot carry a body (see header).
                  Renders nothing for a bodyless template. */}
              <TemplateRenderedPreview bodyHtml={props.detail?.bodyHTML} />

              <View style={{ gap: 8 }}>
                <Row label="Subject" value={shown.subject || EMDASH} />
                <Row label="Preview text" value={shown.previewText || EMDASH} />
                <Row label="Description" value={shown.description || EMDASH} />
                <Row label="Origin" value={templateOrigin(shown)} />
                <Row
                  label="Category"
                  value={shown.category || shown.industry || EMDASH}
                />
                <Row
                  label="Used"
                  value={
                    shown.usageCount === 0
                      ? "Never"
                      : `${num(shown.usageCount)}× · last ${date(shown.lastUsedAt)}`
                  }
                />
                <Row
                  label="Quality"
                  // 0–1, and NOT NULL server-side, so an absent field really is
                  // 0.000 rather than "unmeasured". null only survives a
                  // payload that wasn't a number in range — that one gets an
                  // em-dash instead of an invented score.
                  value={
                    shown.qualityScore === null
                      ? EMDASH
                      : percent(shown.qualityScore, { digits: 0 })
                  }
                />
                {shown.tags.length > 0 ? (
                  <Row label="Tags" value={shown.tags.join(", ")} />
                ) : null}
              </View>

              {placeholders ? (
                <Text
                  {...typeCap("bodySmall")}
                  style={{
                    color: t.warning,
                    ...typeStyle("bodySmall"),
                    fontFamily: FONT.regular,
                  }}
                >
                  {placeholders}
                </Text>
              ) : null}

              {gate.allowed ? (
                <Text
                  {...typeCap("caption")}
                  style={{
                    color: t.fgSubtle,
                    ...typeStyle("caption"),
                    fontFamily: FONT.regular,
                  }}
                >
                  Editing the design itself is a desktop job — this screen
                  starts things from it, it does not change it.
                </Text>
              ) : null}

              <TemplateSheetActions
                eligible={gate.allowed}
                ineligibleMessage={gate.message}
                canWrite={props.canWrite}
                online={props.online}
                starting={props.starting}
                duplicating={props.duplicating}
                onStartCampaign={() => props.onStartCampaign(shown)}
                onDuplicate={() => props.onDuplicate(shown)}
              />

              {/* The lifecycle verb: reversible, so it sits below the two
                  creating verbs rather than among them. Its gate (a strong
                  tag off the detail read, an online editor) and its labels
                  are lib/templateLifecycle, shared with the hook that PATCHes. */}
              <TemplateLifecycleAction
                template={shown}
                canWrite={props.canWrite}
                online={props.online}
                toggling={props.archiveToggling === true}
                onToggle={props.onToggleArchived}
              />
            </>
          ) : null}
        </ScrollView>
      </SafeAreaView>
    </ReducedMotionModal>
  );
}
