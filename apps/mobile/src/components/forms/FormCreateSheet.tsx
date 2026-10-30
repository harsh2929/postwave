/**
 * FormCreateSheet — the 4-field create, ported from desktop's "New form"
 * modal (Forms.tsx:1449-1541). This is NOT schema authoring: the server
 * ignores steps on create and hands every new form `defaultStructure()` in
 * status `draft`, so what a phone needs is exactly name / slug / opt-in mode /
 * success message — the same four fields desktop asks for.
 *
 * OFFLINE, THE CREATE QUEUES. `POST /api/v1/forms` is on the offline-queue
 * allowlist and a new form is born a draft, so a tunnel cannot put anything
 * on the public internet. The sheet says "queued" honestly instead of
 * pretending the row exists already.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import { useCallback, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import { SegmentedControl } from "@/components/SegmentedControl";
import { useToast } from "@/components/Toast";
import { useCreateForm } from "@/hooks/useFormOps";
import { useIsOnline } from "@/hooks/useIsOnline";
import {
  FORM_NAME_MAX,
  FORM_SLUG_MAX,
  createFormDraftProblem,
  suggestFormSlug,
  type CreateFormDraft,
} from "@/lib/formLifecycle";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";

const EMPTY_DRAFT: CreateFormDraft = {
  name: "",
  slug: "",
  optInMode: "double",
  successMessage: "",
};

export interface FormCreateSheetProps {
  visible: boolean;
  onClose: () => void;
}

export function FormCreateSheet(props: FormCreateSheetProps) {
  const { t } = useTheme();
  const { toast } = useToast();
  const online = useIsOnline();
  const create = useCreateForm();

  const [draft, setDraft] = useState<CreateFormDraft>(EMPTY_DRAFT);
  const [slugTouched, setSlugTouched] = useState(false);
  const [attempted, setAttempted] = useState(false);

  const problem = createFormDraftProblem(draft);

  const close = useCallback(() => {
    setDraft(EMPTY_DRAFT);
    setSlugTouched(false);
    setAttempted(false);
    props.onClose();
  }, [props]);

  const submit = useCallback(() => {
    setAttempted(true);
    if (problem) {
      haptics.error();
      return;
    }
    haptics.impact();
    if (!online) {
      // The mutation PAUSES offline (networkMode "online") and replays on
      // reconnect; its callbacks will not fire until then. Say what actually
      // happened — queued, not created — and get out of the way.
      create.mutate(draft);
      toast({
        kind: "success",
        message: `“${draft.name.trim()}” is queued and will be created as a draft when you reconnect.`,
      });
      close();
      return;
    }
    create.mutate(draft, {
      onSuccess: () => {
        haptics.success();
        toast({
          kind: "success",
          message: `“${draft.name.trim()}” created as a draft. Publish it when it's ready.`,
        });
        close();
      },
      onError: (error) => {
        haptics.error();
        toast({
          kind: "error",
          message:
            error instanceof Error && error.message
              ? error.message
              : "Couldn't create the form. Please try again.",
        });
      },
    });
  }, [close, create, draft, online, problem, toast]);

  return (
    <ReducedMotionModal
      visible={props.visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={close}
    >
      <SafeAreaView
        style={{ flex: 1, backgroundColor: t.bg }}
        edges={["top", "bottom"]}
      >
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              paddingHorizontal: 16,
              paddingVertical: 12,
              borderBottomColor: t.borderSubtle,
              borderBottomWidth: 1,
            }}
          >
            <Text
              accessibilityRole="header"
              {...typeCap("title")}
              style={{
                color: t.fg,
                ...typeStyle("title"),
                fontFamily: FONT.display,
              }}
            >
              New form
            </Text>
            <Pressable
              onPress={close}
              accessibilityRole="button"
              accessibilityLabel="Cancel creating a form"
              style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 8 }}
            >
              <Text
                {...typeCap("callout")}
                style={{
                  color: t.accent,
                  ...typeStyle("callout"),
                  fontFamily: FONT.semibold,
                }}
              >
                Cancel
              </Text>
            </Pressable>
          </View>

          <ScrollView
            contentContainerStyle={{ padding: 16, gap: 14 }}
            keyboardShouldPersistTaps="handled"
          >
            <Field label="Name">
              <Input
                value={draft.name}
                maxLength={FORM_NAME_MAX}
                placeholder="Spring popup"
                accessibilityLabel="Form name"
                onChangeText={(name) =>
                  setDraft((d) => ({
                    ...d,
                    name,
                    ...(slugTouched ? {} : { slug: suggestFormSlug(name) }),
                  }))
                }
              />
            </Field>

            <Field
              label="Slug"
              hint={`Becomes the public URL: /forms/${draft.slug.trim() || "…"}`}
            >
              <Input
                value={draft.slug}
                maxLength={FORM_SLUG_MAX}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="spring-popup"
                accessibilityLabel="Form slug"
                onChangeText={(slug) => {
                  setSlugTouched(true);
                  setDraft((d) => ({ ...d, slug }));
                }}
              />
            </Field>

            <Field
              label="Opt-in mode"
              hint={
                draft.optInMode === "double"
                  ? "Double: signups confirm by email before they count. Recommended."
                  : "Single: signups count immediately, with no confirmation email."
              }
            >
              <SegmentedControl
                accessibilityLabel="Opt-in mode"
                options={[
                  { value: "double", label: "Double opt-in" },
                  { value: "single", label: "Single opt-in" },
                ]}
                value={draft.optInMode}
                onChange={(optInMode) =>
                  setDraft((d) => ({
                    ...d,
                    optInMode: optInMode as CreateFormDraft["optInMode"],
                  }))
                }
              />
            </Field>

            <Field label="Success message" hint="Shown after someone signs up.">
              <Input
                value={draft.successMessage}
                maxLength={2000}
                multiline
                placeholder="Thanks — check your inbox!"
                accessibilityLabel="Success message"
                onChangeText={(successMessage) =>
                  setDraft((d) => ({ ...d, successMessage }))
                }
              />
            </Field>

            {attempted && problem ? (
              <Text
                accessibilityLiveRegion="polite"
                {...typeCap("label")}
                style={{
                  color: t.warning,
                  ...typeStyle("label"),
                  fontFamily: FONT.regular,
                }}
              >
                {problem}
              </Text>
            ) : null}

            <Pressable
              onPress={submit}
              disabled={create.isPending}
              accessibilityRole="button"
              accessibilityLabel="Create the form as a draft"
              accessibilityState={{ disabled: create.isPending }}
              style={{
                minHeight: 48,
                borderRadius: 12,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: t.accent,
                opacity: create.isPending ? 0.45 : 1,
              }}
            >
              <Text
                {...typeCap("control")}
                style={{
                  color: t.accentFg,
                  ...typeStyle("control"),
                  fontFamily: FONT.semibold,
                }}
              >
                {create.isPending
                  ? "Creating…"
                  : online
                    ? "Create draft"
                    : "Queue create for reconnect"}
              </Text>
            </Pressable>

            <Text
              {...typeCap("caption")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("caption"),
                fontFamily: FONT.regular,
              }}
            >
              New forms start as drafts with a single email field. Fields and
              steps are edited in the form builder on the web app; publishing
              can be done right here.
            </Text>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </ReducedMotionModal>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  const { t } = useTheme();
  return (
    <View style={{ gap: 6 }}>
      <Text
        {...typeCap("label")}
        style={{
          color: t.fgMuted,
          ...typeStyle("label"),
          fontFamily: FONT.semibold,
        }}
      >
        {label}
      </Text>
      {children}
      {hint ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

function Input(props: {
  value: string;
  onChangeText: (next: string) => void;
  placeholder: string;
  accessibilityLabel: string;
  maxLength: number;
  multiline?: boolean;
  autoCapitalize?: "none";
  autoCorrect?: boolean;
}) {
  const { t } = useTheme();
  return (
    <TextInput
      value={props.value}
      onChangeText={props.onChangeText}
      placeholder={props.placeholder}
      placeholderTextColor={t.fgSubtle}
      accessibilityLabel={props.accessibilityLabel}
      maxLength={props.maxLength}
      multiline={props.multiline ?? false}
      {...(props.multiline ? {} : { returnKeyType: "done" as const })}
      {...(props.autoCapitalize ? { autoCapitalize: props.autoCapitalize } : {})}
      {...(props.autoCorrect === undefined
        ? {}
        : { autoCorrect: props.autoCorrect })}
      {...typeCap("body")}
      style={{
        color: t.fg,
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingVertical: 10,
        fontSize: fontSizeFor("body"),
        fontFamily: FONT.regular,
        minHeight: props.multiline ? 88 : 44,
      }}
    />
  );
}
