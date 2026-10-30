/**
 * FrameworkReferenceCard — what the framework IS, and what is normally in
 * place before anybody attests to it.
 *
 * NOT A CHECKLIST WITH STATE. The desktop renders the same items
 * (`apps/desktop/src/components/compliance/FrameworkMeta.ts`) as a soft
 * checklist beside its attest button; nothing in the API stores which of them
 * are done — there is no per-gate column in `compliance_programs` (migration
 * 0193 lines 24-38) and no endpoint that reports one. Rendering tick boxes here
 * would invite a reader to tick something that is never persisted, so these are
 * bullets: reading material for the person who is about to have the
 * conversation, not a form.
 *
 * THE SPEC LINK IS THE ONE ACTION ON THIS SCREEN, and it is safe by
 * construction: an in-app browser to a public standards body, with no token, no
 * tenant and nothing written anywhere.
 */
import { useCallback } from "react";
import { Pressable, Text, View } from "react-native";
import * as WebBrowser from "expo-web-browser";

import { useToast } from "@/components/Toast";
import type { ComplianceFrameworkMeta } from "@/lib/complianceFrameworks";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export function FrameworkReferenceCard({
  meta,
}: {
  meta: ComplianceFrameworkMeta;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const url = meta.url;

  const onOpen = useCallback(() => {
    if (!url) return;
    haptics.tap();
    void WebBrowser.openBrowserAsync(url).catch(() =>
      toast({ kind: "error", message: "Couldn't open the browser." }),
    );
  }, [toast, url]);

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 14,
        padding: 14,
        marginTop: 12,
        gap: 10,
      }}
    >
      <Text
        {...typeCap("bodySmall")}
        style={{
          color: t.fgMuted,
          ...typeStyle("bodySmall"),
          fontFamily: FONT.regular,
        }}
      >
        {meta.blurb}
      </Text>

      {meta.gates.length > 0 ? (
        <View style={{ gap: 6 }}>
          <Text
            accessibilityRole="header"
            {...typeCap("label")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("label"),
              fontFamily: FONT.semibold,
            }}
          >
            Normally in place before attesting
          </Text>
          {meta.gates.map((gate) => (
            <Text
              key={gate}
              {...typeCap("bodySmall")}
              style={{
                color: t.fgMuted,
                ...typeStyle("bodySmall"),
                fontFamily: FONT.regular,
              }}
            >
              {`• ${gate}`}
            </Text>
          ))}
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
            }}
          >
            Nothing tracks which of these are done — the API stores no per-item
            state, so these are notes rather than a checklist.
          </Text>
        </View>
      ) : null}

      {url ? (
        <Pressable
          onPress={onOpen}
          accessibilityRole="link"
          accessibilityLabel={`Open the ${meta.short} specification in a browser`}
          style={{
            borderColor: t.borderSubtle,
            borderWidth: 1,
            borderRadius: 10,
            paddingHorizontal: 12,
            paddingVertical: 10,
            minHeight: 44,
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
            Open the {meta.short} specification
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
