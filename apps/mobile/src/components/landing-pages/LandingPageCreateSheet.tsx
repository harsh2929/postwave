/**
 * LandingPageCreateSheet — the 2-field landing-page create (name + slug),
 * split out of LandingPageAdminActions at its source budget.
 *
 * Desktop's exact create body ({slug, name}); pages are born drafts and the
 * block editor stays on the web. ADMIN + online-only, like every landing
 * write.
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
import { useToast } from "@/components/Toast";
import { useIsOnline } from "@/hooks/useIsOnline";
import { useCreateLandingPage } from "@/hooks/useLandingPages";
import { LANDING_OFFLINE_MESSAGE as OFFLINE_MESSAGE } from "@/components/landing-pages/LandingPageAdminActions";
import {
  createLandingDraftProblem,
  suggestLandingSlug,
} from "@/lib/landingLifecycle";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { fontSizeFor, typeCap, typeStyle } from "@/lib/typeScale";

export interface LandingPageCreateSheetProps {
  visible: boolean;
  onClose: () => void;
}

/** Name + slug — desktop's exact create body; the block editor stays web. */
export function LandingPageCreateSheet(props: LandingPageCreateSheetProps) {
  const { t } = useTheme();
  const { toast } = useToast();
  const online = useIsOnline();
  const create = useCreateLandingPage();

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [attempted, setAttempted] = useState(false);

  const problem = createLandingDraftProblem({ name, slug });

  const close = useCallback(() => {
    setName("");
    setSlug("");
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
    if (!online) {
      haptics.error();
      toast({ kind: "error", message: OFFLINE_MESSAGE });
      return;
    }
    haptics.impact();
    create.mutate(
      { name, slug },
      {
        onSuccess: () => {
          haptics.success();
          toast({
            kind: "success",
            message: `“${name.trim()}” created as a draft. Build it in the block editor on the web app, then publish it from here or there.`,
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
                : "Couldn't create the page. Please try again.",
          });
        },
      },
    );
  }, [close, create, name, online, problem, slug, toast]);

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
              New landing page
            </Text>
            <Pressable
              onPress={close}
              accessibilityRole="button"
              accessibilityLabel="Cancel creating a landing page"
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
            <SheetInput
              label="Name"
              value={name}
              placeholder="Spring launch"
              accessibilityLabel="Landing page name"
              onChangeText={(next) => {
                setName(next);
                if (!slugTouched) setSlug(suggestLandingSlug(next));
              }}
            />
            <SheetInput
              label="Slug"
              value={slug}
              placeholder="spring-launch"
              accessibilityLabel="Landing page slug"
              hint={`Becomes the public URL: /landing/${slug.trim() || "…"}`}
              autoCapitalize="none"
              onChangeText={(next) => {
                setSlugTouched(true);
                setSlug(next);
              }}
            />

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
              accessibilityLabel="Create the landing page as a draft"
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
                {create.isPending ? "Creating…" : "Create draft"}
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
              New pages start as empty drafts. Content is built in the block
              editor on the web app; a draft&apos;s public URL is not served
              until it is published.
            </Text>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </ReducedMotionModal>
  );
}

function SheetInput(props: {
  label: string;
  value: string;
  onChangeText: (next: string) => void;
  placeholder: string;
  accessibilityLabel: string;
  hint?: string;
  autoCapitalize?: "none";
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
        {props.label}
      </Text>
      <TextInput
        value={props.value}
        onChangeText={props.onChangeText}
        placeholder={props.placeholder}
        placeholderTextColor={t.fgSubtle}
        accessibilityLabel={props.accessibilityLabel}
        returnKeyType="done"
        maxLength={128}
        {...(props.autoCapitalize
          ? { autoCapitalize: props.autoCapitalize, autoCorrect: false }
          : {})}
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
          minHeight: 44,
        }}
      />
      {props.hint ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            ...typeStyle("caption"),
            fontFamily: FONT.regular,
          }}
        >
          {props.hint}
        </Text>
      ) : null}
    </View>
  );
}
