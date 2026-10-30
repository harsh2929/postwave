/**
 * SubjectLineSuggestions (mobile) — RN port of the desktop panel.
 * Streams 3 subject-line variants from the voice service while the
 * user types. Mounts when the subject input has ≥ 10 characters; the
 * parent decides when to show it.
 *
 * Endpoint: POST /api/v1/voice/generate (kind: "subject_line"). The
 * voice handler asks the AI model for a numbered list and we parse the
 * streamed text into the first 3 enumerated lines.
 *
 * Honest-fallback policy: if the SSE stream errors or the voice
 * service is not configured, we surface a muted "AI service
 * unavailable" message rather than fabricating variants.
 */
import { type ReactElement, useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { AI_DISCLOSURE_TEXT } from "@postwave/ai-disclosure";

import { streamAIGenerate, type AIStreamHandle } from "@/api/aiGenerate";
import { FONT } from "@/lib/fonts";
import { typeCap } from "@/lib/typeScale";
import { useTheme } from "@/lib/theme";

interface Props {
  /** The subject the user has typed so far. Used as the prompt brief. */
  currentSubject: string;
  /** Optional voice profile id — passed through as a context ref so the
   *  voice service can apply tenant-specific tone. */
  voiceProfileId?: string | null;
  /** Called when the user taps "Use this" on a variant. */
  onPickVariant: (text: string) => void;
  /** Optional callback for the "A/B test all" button. When omitted, the
   *  button is hidden. Mirrors the desktop prop name (onTestAll) so the
   *  surfaces share a vocabulary. */
  onTestAll?: (variants: string[]) => void;
  /** Notified with the number of usable variants parsed so far, so a caller
   *  can describe an even split ("about 33% each") without re-parsing. */
  onVariantsChange?: (count: number) => void;
}

function cleanVariant(line: string): string {
  let s = line.trim();
  s = s.replace(/^(?:\(?\d+\)?[.):\-]\s*|[-•*]\s+)/, "");
  s = s.replace(/^["'“‘*_]+|["'”’*_]+$/g, "");
  return s.trim();
}

function parseVariants(text: string): string[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const numbered: string[] = [];
  for (const raw of lines) {
    const m = raw.match(/^\s*\(?(\d+)\)?[.):\-]\s*(.+)$/);
    if (m && m[2]) {
      numbered.push(cleanVariant(m[2]));
      if (numbered.length >= 3) break;
    }
  }
  if (numbered.length > 0) return numbered;
  return lines
    .map((l) => cleanVariant(l))
    .filter(Boolean)
    .slice(0, 3);
}

/**
 * The three variant rows. Extracted so the main component stays inside the
 * function-length budget — the file is a single screen-sized control and the
 * rows are the bulk of it.
 */
function VariantSlots({
  slots,
  done,
  onPickVariant,
}: {
  slots: readonly (string | null)[];
  done: boolean;
  onPickVariant: (text: string) => void;
}): ReactElement {
  const { t } = useTheme();
  return (
    <View style={{ gap: 8 }}>
      {slots.map((text, idx) => (
        <View
          key={idx}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingVertical: 6,
          }}
        >
          <Text
            {...typeCap("numeric")}
            style={{
              color: t.fgSubtle,
              fontSize: 12,
              width: 18,
              fontFamily: FONT.regular,
              fontVariant: ["tabular-nums"],
            }}
          >
            {idx + 1}.
          </Text>
          {text ? (
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.fg,
                fontSize: 13,
                flex: 1,
                fontFamily: FONT.regular,
                // Tenant/AI content can be RTL.
                writingDirection: "auto",
              }}
              numberOfLines={2}
            >
              {text}
            </Text>
          ) : !done ? (
            <View
              style={{
                flex: 1,
                height: 12,
                borderRadius: 4,
                backgroundColor: t.surfaceElevated,
              }}
              accessibilityLabel="generating"
            />
          ) : (
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.fgSubtle,
                fontSize: 13,
                flex: 1,
                fontFamily: FONT.regular,
              }}
              accessibilityLabel="no suggestion"
            >
              —
            </Text>
          )}
          <Pressable
            onPress={() => {
              if (text) onPickVariant(text);
            }}
            disabled={!text}
            accessibilityRole="button"
            accessibilityLabel={`Use variant ${idx + 1}`}
            style={{
              backgroundColor: !text ? t.surfaceElevated : t.accent,
              paddingHorizontal: 10,
              paddingVertical: 6,
              minHeight: 44,
              minWidth: 76,
              borderRadius: 8,
              alignItems: "center",
              justifyContent: "center",
              opacity: !text ? 0.5 : 1,
            }}
          >
            <Text
              {...typeCap("caption")}
              style={{
                color: !text ? t.fgSubtle : t.accentFg,
                fontSize: 11,
                fontWeight: "700",
                fontFamily: FONT.bold,
              }}
            >
              Use this
            </Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

export function SubjectLineSuggestions({
  currentSubject,
  voiceProfileId,
  onPickVariant,
  onTestAll,
  onVariantsChange,
}: Props): ReactElement {
  const { t } = useTheme();
  const [streamText, setStreamText] = useState<string>("");
  const [done, setDone] = useState<boolean>(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const handleRef = useRef<AIStreamHandle | null>(null);

  // Debounce the stream against subject changes so we don't fire a new
  // generation per keystroke. 500ms matches the desktop cadence.
  useEffect(() => {
    if (!currentSubject || currentSubject.trim().length < 10) {
      handleRef.current?.abort();
      handleRef.current = null;
      setStreamText("");
      setDone(false);
      setErrMsg(null);
      return;
    }
    const timer = setTimeout(() => {
      handleRef.current?.abort();
      setStreamText("");
      setDone(false);
      setErrMsg(null);
      const prompt =
        `Generate 3 high-performing subject-line alternatives for the ` +
        `following draft. Match the user's tone and intent. Return them ` +
        `as a numbered list (1., 2., 3.) — one subject per line, no ` +
        `commentary.\n\nDraft subject: ${currentSubject.trim()}`;
      handleRef.current = streamAIGenerate(
        {
          prompt,
          kind: "subject_line",
          contextRefs: voiceProfileId
            ? [{ type: "voice_profile", id: voiceProfileId }]
            : [],
        },
        {
          onDelta: (chunk) => {
            setStreamText((prev) => prev + chunk);
          },
          onDone: () => {
            setDone(true);
          },
          onError: (msg) => {
            setErrMsg(msg);
            setDone(true);
          },
        },
      );
    }, 500);
    return () => {
      clearTimeout(timer);
    };
  }, [currentSubject, voiceProfileId]);

  // Cleanup any in-flight stream on unmount.
  useEffect(() => {
    return () => {
      handleRef.current?.abort();
      handleRef.current = null;
    };
  }, []);

  const variants = parseVariants(streamText);
  const variantCount = variants.length;
  useEffect(() => {
    onVariantsChange?.(variantCount);
  }, [variantCount, onVariantsChange]);
  const slots: (string | null)[] = [
    variants[0] ?? null,
    variants[1] ?? null,
    variants[2] ?? null,
  ];

  if (errMsg) {
    return (
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          backgroundColor: t.surface,
          borderColor: t.borderSubtle,
          borderWidth: 1,
          borderRadius: 12,
          padding: 12,
          marginTop: 8,
        }}
        accessibilityRole="alert"
      >
        <Text
          {...typeCap("callout")}
          style={{ color: t.fgMuted, fontSize: 14, fontFamily: FONT.regular }}
          aria-hidden
        >
          {"◐"}
        </Text>
        <Text
          {...typeCap("label")}
          style={{
            color: t.fgSubtle,
            fontSize: 12,
            flex: 1,
            fontFamily: FONT.regular,
          }}
        >
          AI subject-line suggestions unavailable: {errMsg}
        </Text>
      </View>
    );
  }

  return (
    <View
      style={{
        backgroundColor: t.surface,
        borderColor: t.borderSubtle,
        borderWidth: 1,
        borderRadius: 12,
        padding: 12,
        marginTop: 8,
        gap: 8,
      }}
      accessibilityLabel="AI subject-line suggestions"
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text
          {...typeCap("callout")}
          style={{ color: t.accent, fontSize: 14, fontFamily: FONT.regular }}
          aria-hidden
        >
          {"✦"}
        </Text>
        <Text
          {...typeCap("label")}
          style={{
            color: t.fg,
            fontSize: 12,
            fontWeight: "600",
            fontFamily: FONT.semibold,
            flex: 1,
          }}
        >
          AI proposed {variantCount > 0 ? variantCount : 3} variant
          {variantCount === 1 ? "" : "s"} based on your voice profile
        </Text>
      </View>
      <Text
        {...typeCap("caption")}
        accessibilityRole="text"
        style={{ color: t.fgSubtle, fontSize: 11, fontFamily: FONT.regular }}
      >
        {AI_DISCLOSURE_TEXT}
      </Text>
      <VariantSlots slots={slots} done={done} onPickVariant={onPickVariant} />
      {!done ? (
        <Text
          {...typeCap("caption")}
          style={{ color: t.fgSubtle, fontSize: 11, fontFamily: FONT.regular }}
        >
          Streaming…
        </Text>
      ) : null}
      {/* An EXACT-3 gate hid this button whenever the stream yielded two
          usable lines, with no explanation — and made the caller's own
          `variants.length < 2` guard unreachable dead code. Two arms is a
          valid A/B test. */}
      {onTestAll && done && variants.length >= 2 ? (
        <Pressable
          onPress={() => onTestAll(variants)}
          accessibilityRole="button"
          accessibilityLabel={`A/B test all ${variants.length} variants`}
          style={{
            backgroundColor: t.accent,
            paddingVertical: 8,
            paddingHorizontal: 12,
            minHeight: 44,
            borderRadius: 8,
            alignSelf: "flex-start",
            justifyContent: "center",
            marginTop: 4,
          }}
        >
          <Text
            {...typeCap("label")}
            style={{
              color: t.accentFg,
              fontSize: 12,
              fontWeight: "700",
              fontFamily: FONT.bold,
            }}
          >
            A/B test all {variants.length}
          </Text>
        </Pressable>
      ) : null}
      {onTestAll && done && variants.length > 0 && variants.length < 3 ? (
        <Text
          {...typeCap("caption")}
          style={{
            color: t.fgSubtle,
            fontSize: 11,
            lineHeight: 16,
            marginTop: 4,
            fontFamily: FONT.regular,
          }}
        >
          {variants.length === 1
            ? "Only one usable variant came back — an A/B test needs at least two. Edit the subject and try again."
            : "Only two usable variants came back; the test will run with two arms."}
        </Text>
      ) : null}
    </View>
  );
}
