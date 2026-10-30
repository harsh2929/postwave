/**
 * VoiceTemplatesCard — the workspace's shared prompt/template library.
 *
 * GET /api/v1/voice/templates is `read:campaigns`, so a viewer BROWSES and can
 * copy a prompt; delete needs admin and generate needs editor, and neither
 * button exists below its floor rather than being offered and 403ing.
 *
 * Only category chips the fetched library actually uses are rendered — a
 * filter row of thirteen buckets where twelve are empty is a worse read than
 * the three that exist. The filter runs client-side over one fetch, so a tap
 * cannot turn into an empty list caused by a dropped request.
 */
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";

import { Card } from "@/components/Card";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { SkeletonCard } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { VoiceTemplateGenerateSheet } from "@/components/voice/VoiceTemplateGenerateSheet";
import { VoiceTemplateSheet } from "@/components/voice/VoiceTemplateSheet";
import { copyToClipboard } from "@/lib/clipboard";
import { FONT } from "@/lib/fonts";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";
import {
  filterVoiceTemplates,
  voiceTemplateCategoryLabel,
  voiceTemplateSummary,
  voiceTemplateTitle,
  type GeneratedTemplate,
  type VoiceTemplateWire,
} from "@/lib/voiceTemplates";
import {
  useDeleteVoiceTemplate,
  useGenerateVoiceTemplate,
  useVoiceTemplates,
} from "@/hooks/useVoiceTemplates";

export function VoiceTemplatesCard({
  offline,
  canGenerate,
  canAdmin,
}: {
  offline: boolean;
  canGenerate: boolean;
  canAdmin: boolean;
}) {
  const { t } = useTheme();
  const { toast } = useToast();
  const query = useVoiceTemplates(!offline);
  const generate = useGenerateVoiceTemplate();
  const remove = useDeleteVoiceTemplate();

  const [category, setCategory] = useState("");
  const [open, setOpen] = useState<VoiceTemplateWire | null>(null);
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<GeneratedTemplate | null>(null);
  const [genError, setGenError] = useState<string | null>(null);

  const rows = useMemo(
    () => (Array.isArray(query.data) ? query.data : []),
    [query.data],
  );
  const categories = useMemo(() => {
    const seen: string[] = [];
    for (const row of rows) {
      const value = typeof row.category === "string" ? row.category.trim() : "";
      if (value && !seen.includes(value)) seen.push(value);
    }
    return seen;
  }, [rows]);
  const shown = useMemo(
    () => filterVoiceTemplates(rows, category),
    [rows, category],
  );

  const copy = (text: string) => {
    void copyToClipboard(text).then((ok) => {
      toast({
        kind: ok ? "success" : "error",
        message: ok ? "Copied." : "Couldn't reach the clipboard.",
      });
    });
  };

  if (offline) return null;

  return (
    <Card style={{ gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text
          {...typeCap("heading")}
          style={{
            color: t.fg,
            ...typeStyle("heading"),
            fontWeight: "500",
            fontFamily: FONT.medium,
            flex: 1,
          }}
        >
          Saved prompts
        </Text>
        {canGenerate ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Generate a template from a brief"
            hitSlop={8}
            onPress={() => {
              haptics.tap();
              setResult(null);
              setGenError(null);
              setGenerating(true);
            }}
            style={{ minHeight: 44, justifyContent: "center" }}
          >
            <Text
              {...typeCap("bodySmall")}
              style={{
                color: t.accent,
                ...typeStyle("bodySmall"),
                fontWeight: "600",
                fontFamily: FONT.semibold,
              }}
            >
              Generate
            </Text>
          </Pressable>
        ) : null}
      </View>

      {query.isLoading ? (
        <SkeletonCard lines={3} />
      ) : query.isError ? (
        <ErrorState
          compact
          error={query.error}
          onRetry={() => void query.refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No shared templates"
          description="This workspace has no prompt starters yet. Admins add them from desktop; you can still generate a one-off draft here."
        />
      ) : (
        <>
          {categories.length > 1 ? (
            <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
              {["", ...categories].map((value) => (
                <Pressable
                  key={value || "all"}
                  accessibilityRole="button"
                  accessibilityLabel={
                    value ? voiceTemplateCategoryLabel(value) : "All categories"
                  }
                  accessibilityState={{ selected: category === value }}
                  onPress={() => {
                    haptics.tap();
                    setCategory(value);
                  }}
                  style={{
                    minHeight: 44,
                    justifyContent: "center",
                    paddingHorizontal: 12,
                    borderRadius: 999,
                    borderWidth: 1,
                    borderColor: category === value ? t.accent : t.border,
                  }}
                >
                  <Text
                    {...typeCap("bodySmall")}
                    style={{
                      color: category === value ? t.accent : t.fgMuted,
                      ...typeStyle("bodySmall"),
                      fontFamily: FONT.regular,
                    }}
                  >
                    {value ? voiceTemplateCategoryLabel(value) : "All"}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}

          {shown.slice(0, 8).map((row) => (
            <Pressable
              key={String(row.id)}
              accessibilityRole="button"
              accessibilityLabel={`Open template ${voiceTemplateTitle(row)}`}
              onPress={() => {
                haptics.tap();
                setOpen(row);
              }}
              style={{ minHeight: 44, justifyContent: "center", gap: 2 }}
            >
              <Text
                {...typeCap("body")}
                style={{
                  color: t.fg,
                  ...typeStyle("body"),
                  fontFamily: FONT.regular,
                }}
                numberOfLines={1}
              >
                {voiceTemplateTitle(row)}
              </Text>
              <Text
                {...typeCap("label")}
                style={{
                  color: t.fgSubtle,
                  ...typeStyle("label"),
                  fontFamily: FONT.regular,
                }}
              >
                {voiceTemplateSummary(row)}
              </Text>
            </Pressable>
          ))}
          {shown.length > 8 ? (
            <Text
              {...typeCap("label")}
              style={{
                color: t.fgSubtle,
                ...typeStyle("label"),
                fontFamily: FONT.regular,
              }}
            >
              {`Showing 8 of ${shown.length}. Filter by category to narrow it.`}
            </Text>
          ) : null}
        </>
      )}

      <VoiceTemplateSheet
        template={open}
        canDelete={canAdmin}
        deleting={remove.isPending}
        onCopy={copy}
        onDelete={(id) => {
          remove.mutate(id, {
            onSuccess: () => {
              setOpen(null);
              toast({ kind: "success", message: "Template deleted." });
            },
            onError: (err) => {
              toast({ kind: "error", message: (err as Error).message });
            },
          });
        }}
        onClose={() => setOpen(null)}
      />

      <VoiceTemplateGenerateSheet
        visible={generating}
        generating={generate.isPending}
        result={result}
        serverError={genError}
        onGenerate={(body) => {
          setGenError(null);
          generate.mutate(body, {
            onSuccess: (draft) => setResult(draft),
            onError: (err) => setGenError((err as Error).message),
          });
        }}
        onCopy={copy}
        onClose={() => setGenerating(false)}
      />
    </Card>
  );
}
