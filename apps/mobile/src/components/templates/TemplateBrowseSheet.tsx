/**
 * TemplateBrowseSheet — one modal, two curated feeds: a collection's designs,
 * or a saved search's results.
 *
 * WHY A SHEET AND NOT LOCAL FILTER STATE. A saved search's stored definition
 * can carry axes this phone has no control for (category, provider, style,
 * tags…). `GET /saved/{id}/results` re-runs the FULL definition server-side,
 * so this feed is the only honest way to "apply" one from a phone — poking
 * q/goal into the local filters would run a DIFFERENT search under the same
 * name. Collections are the same shape of thing: a curated membership list,
 * not an expressible filter.
 *
 * THE DETAIL SHEET RENDERS INSIDE THIS MODAL'S TREE (`detailSheet` prop),
 * exactly like AssetDetailSheet hosts its organise sheet: iOS stacks a modal
 * presented FROM a modal but refuses a sibling while this one is front-most,
 * so the screen hands the same element here instead of mounting it twice.
 *
 * Both hooks are called on every render (hook order), gated by `enabled` on
 * the id each is given; only the matching one ever fetches.
 *
 * NativeWind v4 gotcha: static Pressable style objects only.
 */
import type { ReactNode } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ReducedMotionModal } from "@/components/ReducedMotionModal";
import { SkeletonList } from "@/components/Skeleton";
import { TemplateRow } from "@/components/templates/TemplateRow";
import {
  useSavedSearchResults,
  useTemplateCollection,
} from "@/hooks/useTemplateDiscovery";
import { FONT } from "@/lib/fonts";
import { MOBILE_LIST_PERF_PROPS } from "@/lib/listPerf";
import type { MobileTemplate } from "@/lib/templateCatalog";
import { useTheme } from "@/lib/theme";
import { typeCap, typeStyle } from "@/lib/typeScale";

export interface TemplateBrowseSource {
  kind: "collection" | "saved-search";
  id: string;
  name: string;
}

export interface TemplateBrowseSheetProps {
  source: TemplateBrowseSource | null;
  onClose: () => void;
  onOpenTemplate: (template: MobileTemplate) => void;
  now: number;
  /** The screen's TemplateDetailSheet, hosted inside this modal's tree. */
  detailSheet?: ReactNode;
}

export function TemplateBrowseSheet(props: TemplateBrowseSheetProps) {
  const { t } = useTheme();
  const source = props.source;
  const collection = useTemplateCollection(
    source?.kind === "collection" ? source.id : null,
  );
  const results = useSavedSearchResults(
    source?.kind === "saved-search" ? source.id : null,
  );

  const isCollection = source?.kind === "collection";
  const collectionItems = collection.data?.items;
  const rows: MobileTemplate[] = isCollection
    ? (Array.isArray(collectionItems) ? collectionItems : [])
    : (Array.isArray(results.data?.pages) ? results.data.pages : []).flatMap(
        (page) => page.items,
      );
  const loading = isCollection ? collection.isLoading : results.isLoading;
  const failed = isCollection ? collection.isError : results.isError;

  return (
    <ReducedMotionModal
      visible={source !== null}
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
            {source?.name ?? ""}
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

        {!isCollection && source ? (
          <Text
            {...typeCap("caption")}
            style={{
              color: t.fgSubtle,
              ...typeStyle("caption"),
              fontFamily: FONT.regular,
              paddingHorizontal: 16,
              paddingBottom: 8,
            }}
          >
            The full saved definition runs server-side — including any filters
            this phone has no control for.
          </Text>
        ) : null}

        <FlatList
          data={rows}
          keyExtractor={(row) => row.id}
          contentContainerStyle={{ padding: 16, paddingTop: 4, flexGrow: 1 }}
          {...MOBILE_LIST_PERF_PROPS}
          onEndReachedThreshold={0.6}
          onEndReached={() => {
            if (
              !isCollection &&
              results.hasNextPage &&
              !results.isFetchingNextPage
            ) {
              void results.fetchNextPage();
            }
          }}
          ListEmptyComponent={
            loading ? (
              <SkeletonList rows={5} />
            ) : (
              <Text
                {...typeCap("bodySmall")}
                style={{
                  color: t.fgMuted,
                  ...typeStyle("bodySmall"),
                  fontFamily: FONT.regular,
                  textAlign: "center",
                  paddingTop: 32,
                }}
              >
                {failed
                  ? "Couldn't load these designs. Pull down on the library and try again."
                  : isCollection
                    ? "This collection is empty."
                    : "This saved search matches nothing right now."}
              </Text>
            )
          }
          renderItem={({ item }) => (
            <TemplateRow
              template={item}
              onPress={props.onOpenTemplate}
              now={props.now}
            />
          )}
        />
        {props.detailSheet}
      </SafeAreaView>
    </ReducedMotionModal>
  );
}
