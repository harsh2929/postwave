/**
 * CampaignSaveTemplateModal — turn the campaign that just beat benchmark into
 * something the team can reuse, while you are still looking at the numbers.
 *
 * POST /api/v1/campaigns/{id}/save-as-template is admin-scope on the gateway
 * (campaign_to_template.go:69), which is the same boundary campaignAccess
 * already documents as `canAdmin` — so the button is only rendered for an
 * admin rather than being offered and then 403-ing.
 *
 * The slug is validated locally against the gateway's own regex before send
 * (see lib/campaignTemplateSlug). It is derived from the name as you type,
 * until you edit it yourself — after which it is yours and is never silently
 * rewritten, which is the behaviour every slug field in the product should
 * have and the one people notice when it is missing.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  KeyboardFormSheet,
  type ReturnFocusRef,
} from "@/components/KeyboardFormSheet";
import { useToast } from "@/components/Toast";
import {
  ActionButton,
  ModalHeader,
} from "@/components/campaigns/CampaignDetailControls";
import { rawRequest } from "@/api/request";
import {
  saveAsTemplateProblem,
  slugifyTemplateName,
  TEMPLATE_SLUG_MAX,
  templateSlugProblem,
} from "@/lib/campaignTemplateSlug";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme, type ThemeTokens } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function CampaignSaveTemplateModal({
  visible,
  onClose,
  campaignId,
  campaignName,
  returnFocusRef,
}: {
  visible: boolean;
  onClose: () => void;
  campaignId: string;
  campaignName: string;
  returnFocusRef?: ReturnFocusRef | undefined;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [name, setName] = useState(campaignName);
  const [slug, setSlug] = useState(() => slugifyTemplateName(campaignName));
  // Once the operator edits the slug it stops tracking the name. Rewriting a
  // hand-picked slug on the next keystroke is the single most annoying
  // behaviour a paired name/slug field can have.
  const [slugTouched, setSlugTouched] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setName(campaignName);
    setSlug(slugifyTemplateName(campaignName));
    setSlugTouched(false);
  }, [visible, campaignName]);

  const save = useMutation({
    mutationFn: async (input: { name: string; slug: string }) => {
      const res = await rawRequest<{ id?: string }>(
        "POST",
        `/api/v1/campaigns/${encodeURIComponent(campaignId)}/save-as-template`,
        { slug: input.slug, name: input.name },
      );
      if (res.error) {
        throw new Error(
          saveAsTemplateProblem(
            res.error.status,
            res.error.code,
            res.error.message,
          ),
        );
      }
      return res.data ?? {};
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["campaign-templates"] });
      onClose();
      toast({ kind: "success", message: `Saved as a template: ${slug}` });
    },
    onError: (err: unknown) => {
      haptics.error();
      toast({
        kind: "error",
        message:
          err instanceof Error ? err.message : "Couldn't save the template.",
      });
    },
  });

  const trimmedSlug = slug.trim();
  const slugProblem = templateSlugProblem(trimmedSlug);
  const trimmedName = name.trim();

  const handleNameChange = useCallback(
    (next: string) => {
      setName(next);
      if (!slugTouched) setSlug(slugifyTemplateName(next));
    },
    [slugTouched],
  );

  const slugRef = useRef<TextInput | null>(null);

  const handleSave = useCallback(() => {
    if (slugProblem || save.isPending) return;
    save.mutate({ name: trimmedName || campaignName, slug: trimmedSlug });
  }, [campaignName, save, slugProblem, trimmedName, trimmedSlug]);

  return (
    <KeyboardFormSheet
      visible={visible}
      onClose={onClose}
      accessibilityLabel="Save campaign as template"
      returnFocusRef={returnFocusRef}
    >
      <ModalHeader title="Save as template" onClose={onClose} />

      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          marginBottom: 16,
          fontFamily: FONT.regular,
        }}
      >
        Copies this campaign&apos;s subject, preview text and body into the
        workspace template library. The campaign itself is unchanged.
      </Text>

      <Field label="Template name" t={t}>
        <TextInput
          // Inputs scale with the OS text size but their height does not — cap it.
          {...typeCap("body")}
          value={name}
          onChangeText={handleNameChange}
          placeholder="Spring launch"
          placeholderTextColor={t.fgSubtle}
          autoCapitalize="sentences"
          accessibilityLabel="Template name"
          // Chains into the slug, which is the only other field. Without it
          // the return key on the first of two fields did nothing.
          returnKeyType="next"
          submitBehavior="submit"
          onSubmitEditing={() => slugRef.current?.focus()}
          style={inputStyle(t)}
        />
      </Field>

      <Field label="Slug" t={t}>
        <TextInput
          // Inputs scale with the OS text size but their height does not — cap it.
          {...typeCap("body")}
          ref={slugRef}
          value={slug}
          onChangeText={(next) => {
            setSlugTouched(true);
            setSlug(next);
          }}
          placeholder="spring-launch"
          placeholderTextColor={t.fgSubtle}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={TEMPLATE_SLUG_MAX}
          returnKeyType="done"
          onSubmitEditing={handleSave}
          accessibilityLabel="Template slug"
          accessibilityHint="Lowercase letters, numbers and dashes. Must start with a letter."
          style={inputStyle(t)}
        />
        {slugProblem ? (
          <Text
            {...typeCap("caption")}
            accessibilityLiveRegion="polite"
            style={{
              color: t.warning,
              ...typeStyle("caption"),
              marginTop: 6,
              fontFamily: FONT.medium,
            }}
          >
            {slugProblem}
          </Text>
        ) : null}
      </Field>

      <View
        style={{
          flexDirection: "row",
          justifyContent: "flex-end",
          gap: 8,
          marginTop: 20,
        }}
      >
        <ActionButton
          label="Cancel"
          onPress={onClose}
          disabled={save.isPending}
        />
        <ActionButton
          label={save.isPending ? "Saving…" : "Save template"}
          primary
          onPress={handleSave}
          disabled={save.isPending || slugProblem != null}
        />
      </View>
    </KeyboardFormSheet>
  );
}

function Field({
  label,
  t,
  children,
}: {
  label: string;
  t: ThemeTokens;
  children: React.ReactNode;
}) {
  return (
    <View style={{ marginBottom: 14 }}>
      <Text
        {...typeCap("caption")}
        style={{
          color: t.fgMuted,
          ...typeStyle("caption"),
          marginBottom: 6,
          fontFamily: FONT.medium,
        }}
      >
        {label}
      </Text>
      {children}
    </View>
  );
}

function inputStyle(t: ThemeTokens) {
  return {
    color: t.fg,
    backgroundColor: t.surface,
    borderColor: t.border,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    minHeight: 44,
    fontSize: 15,
    fontFamily: FONT.regular,
  } as const;
}
