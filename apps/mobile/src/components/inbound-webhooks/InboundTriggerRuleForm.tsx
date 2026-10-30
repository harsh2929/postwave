/**
 * InboundTriggerRuleForm — create or edit one trigger rule, INLINE inside the
 * rules sheet (the SunsetPoliciesSheet pattern), so there is never a modal
 * presented from a modal and the sheet's own KeyboardAvoidingView carries the
 * keyboard.
 *
 * The fields and their order are the desktop TriggerEditorDialog's: name,
 * event condition (path · operator · value), subscriber-email path, action
 * (type · target). Validation is lib/inboundTriggerRules.validateTriggerDraft,
 * which mirrors trigger_validation.go; a problem is shown beside its field
 * once that field has been touched or a save was attempted, so an untouched
 * form is not a wall of red.
 *
 * What is deliberately NOT here from desktop: the live JSONPath preview
 * against a sample body, and the sequence/tag catalog picker. Both need a
 * retained event or a wide list on hand; the phone validates syntax and says
 * so under the target field.
 */
import { useRef, useState } from "react";
import { Text, TextInput, View } from "react-native";

import { SegmentedControl } from "@/components/SegmentedControl";
import { FONT } from "@/lib/fonts";
import {
  TRIGGER_ACTIONS,
  TRIGGER_OPERATORS,
  TRIGGER_TARGET_SYNTAX_NOTE,
  draftFromRule,
  isTriggerDraftDirty,
  triggerInputFromDraft,
  validateTriggerDraft,
  type InboundTriggerRule,
  type TriggerAction,
  type TriggerOperator,
  type TriggerRuleDraft,
  type TriggerRuleInput,
} from "@/lib/inboundTriggerRules";
import { transitionLabel } from "@/lib/direction";
import { keyboardChain } from "@/lib/keyboardChain";
import { useTheme } from "@/lib/theme";
import { InboundTriggerRuleFormFooter } from "./InboundTriggerRuleFormFooter";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface InboundTriggerRuleFormProps {
  /** Null creates a rule; otherwise the form is seeded from this one. */
  initial: InboundTriggerRule | null;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (input: TriggerRuleInput) => void;
}

type Field = keyof TriggerRuleDraft;

export function InboundTriggerRuleForm({
  initial,
  submitting,
  onCancel,
  onSubmit,
}: InboundTriggerRuleFormProps) {
  const { t } = useTheme();
  // The return key walks the form in the order it is read. `matchValueRef` is
  // skipped when the operator is `exists`, because that field is not rendered.
  const matchJsonpathRef = useRef<TextInput>(null);
  const matchValueRef = useRef<TextInput>(null);
  const emailJsonpathRef = useRef<TextInput>(null);
  const actionTargetRef = useRef<TextInput>(null);
  // Seeded once per mount: the sheet keys this form on the rule id, so a
  // different rule (or "new") is a fresh mount, never stale state.
  const [baseline] = useState<TriggerRuleDraft>(() => draftFromRule(initial));
  const [draft, setDraft] = useState<TriggerRuleDraft>(baseline);
  const [touched, setTouched] = useState<Partial<Record<Field, true>>>({});
  const [attempted, setAttempted] = useState(false);

  const errors = validateTriggerDraft(draft);
  const problemCount = Object.keys(errors).length;
  const dirty = isTriggerDraftDirty(draft, baseline);
  const action =
    TRIGGER_ACTIONS.find((a) => a.value === draft.actionType) ??
    TRIGGER_ACTIONS[0]!;

  const update = <K extends Field>(key: K, value: TriggerRuleDraft[K]) => {
    setDraft((cur) => ({ ...cur, [key]: value }));
    setTouched((cur) => (cur[key] ? cur : { ...cur, [key]: true }));
  };
  const setOperator = (operator: TriggerOperator) => {
    setDraft((cur) => ({
      ...cur,
      operator,
      matchValue: operator === "exists" ? "" : cur.matchValue,
    }));
  };
  const setAction = (actionType: TriggerAction) => {
    // A target is only meaningful for the action it was typed against.
    setDraft((cur) => ({ ...cur, actionType, actionTargetId: "" }));
    setTouched((cur) => ({ ...cur, actionTargetId: undefined as never }));
  };
  const show = (key: Field) => (attempted || touched[key]) && errors[key];
  // Edit of an unchanged rule is a no-op the server would still write.
  const blocked = submitting || (initial !== null && !dirty);

  const submit = () => {
    if (submitting) return;
    setAttempted(true);
    if (problemCount > 0 || blocked) return;
    onSubmit(triggerInputFromDraft(draft));
  };

  const label = (text: string) => (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgMuted,
        ...typeStyle("caption"),
        fontFamily: FONT.semibold,
        textTransform: "uppercase",
        letterSpacing: 0.6,
        marginBottom: 6,
        marginTop: 14,
      }}
    >
      {text}
    </Text>
  );
  const help = (text: string) => (
    <Text
      {...typeCap("caption")}
      style={{
        color: t.fgMuted,
        ...typeStyle("caption"),
        fontFamily: FONT.regular,
        marginTop: 4,
      }}
    >
      {text}
    </Text>
  );
  const problem = (key: Field) =>
    show(key) ? (
      <Text
        accessibilityRole="alert"
        {...typeCap("caption")}
        style={{
          color: t.danger,
          ...typeStyle("caption"),
          fontFamily: FONT.regular,
          marginTop: 4,
        }}
      >
        {errors[key]}
      </Text>
    ) : null;

  const inputStyle = {
    backgroundColor: t.surface,
    borderColor: t.border,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: t.fg,
    fontFamily: FONT.regular,
  } as const;
  // No monospace face ships with the app (Inter + Fraunces only); the path
  // fields disable autocorrect/capitalisation instead, which is what matters.
  const monoStyle = { ...inputStyle, fontFamily: FONT.medium } as const;

  return (
    <View
      style={{
        marginTop: 14,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: t.borderSubtle,
        backgroundColor: t.bgSubtle,
        padding: 14,
      }}
    >
      <Text
        accessibilityRole="header"
        {...typeCap("heading")}
        style={{ color: t.fg, ...typeStyle("heading"), fontFamily: FONT.bold }}
      >
        {initial ? "Edit rule" : "Add rule"}
      </Text>
      {help(
        "One condition on the payload, the path to the subscriber email, then exactly one action.",
      )}

      {label("Rule name")}
      <TextInput
        {...typeCap("body")}
        value={draft.name}
        onChangeText={(v) => update("name", v)}
        accessibilityLabel="Rule name"
        placeholder={transitionLabel("Paid customer", "onboarding")}
        placeholderTextColor={t.fgSubtle}
        autoCapitalize="sentences"
        {...keyboardChain({ next: matchJsonpathRef })}
        style={inputStyle}
      />
      {problem("name")}

      {label("Match JSONPath")}
      <TextInput
        {...typeCap("body")}
        ref={matchJsonpathRef}
        value={draft.matchJsonpath}
        onChangeText={(v) => update("matchJsonpath", v)}
        accessibilityLabel="Match JSONPath"
        placeholder="$.event"
        placeholderTextColor={t.fgSubtle}
        autoCapitalize="none"
        autoCorrect={false}
        {...keyboardChain({
          next: draft.operator === "exists" ? emailJsonpathRef : matchValueRef,
        })}
        style={monoStyle}
      />
      {problem("matchJsonpath")}

      {label("Operator")}
      <SegmentedControl
        accessibilityLabel="Match operator"
        options={TRIGGER_OPERATORS.map((o) => ({ value: o.value, label: o.label }))}
        value={draft.operator}
        onChange={setOperator}
      />

      {draft.operator !== "exists" ? (
        <>
          {label("Comparison value")}
          <TextInput
            {...typeCap("body")}
            ref={matchValueRef}
            value={draft.matchValue}
            onChangeText={(v) => update("matchValue", v)}
            accessibilityLabel="Comparison value"
            placeholder={draft.operator === "regex" ? "^customer\\." : "customer.created"}
            placeholderTextColor={t.fgSubtle}
            autoCapitalize="none"
            autoCorrect={false}
            {...keyboardChain({ next: emailJsonpathRef })}
            style={inputStyle}
          />
          {problem("matchValue")}
        </>
      ) : (
        help("Exists has no comparison value: the rule matches whenever the path resolves.")
      )}

      {label("Subscriber email JSONPath")}
      <TextInput
        {...typeCap("body")}
        ref={emailJsonpathRef}
        value={draft.emailJsonpath}
        onChangeText={(v) => update("emailJsonpath", v)}
        accessibilityLabel="Subscriber email JSONPath"
        placeholder="$.customer.email"
        placeholderTextColor={t.fgSubtle}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        {...keyboardChain({ next: actionTargetRef })}
        style={monoStyle}
      />
      {help("Must resolve to the subscriber email the action applies to.")}
      {problem("emailJsonpath")}

      {label("When matched")}
      <SegmentedControl
        accessibilityLabel="Action"
        options={TRIGGER_ACTIONS.map((a) => ({ value: a.value, label: a.label }))}
        value={draft.actionType}
        onChange={setAction}
        scrollable
      />

      {label(action.targetLabel)}
      <TextInput
        {...typeCap("body")}
        ref={actionTargetRef}
        value={draft.actionTargetId}
        onChangeText={(v) => update("actionTargetId", v)}
        accessibilityLabel={action.targetLabel}
        placeholder={action.targetPlaceholder}
        placeholderTextColor={t.fgSubtle}
        autoCapitalize="none"
        autoCorrect={false}
        {...keyboardChain({ onSubmit: submit, disabled: blocked })}
        style={monoStyle}
      />
      {help(action.targetHelp)}
      {help(TRIGGER_TARGET_SYNTAX_NOTE)}
      {problem("actionTargetId")}

      <InboundTriggerRuleFormFooter
        submitting={submitting}
        blocked={blocked}
        isEdit={initial != null}
        onCancel={onCancel}
        onSubmit={submit}
      />
      {attempted && problemCount > 0 ? (
        <Text
          accessibilityRole="alert"
          {...typeCap("caption")}
          style={{
            color: t.danger,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
            marginTop: 8,
          }}
        >
          {`Fix ${problemCount === 1 ? "the field" : `${problemCount} fields`} marked above before saving.`}
        </Text>
      ) : null}
    </View>
  );
}
