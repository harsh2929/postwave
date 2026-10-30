// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useUnsavedChangesGuard } from "@/components/settings/unsaved-changes";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { verifyFreshAdminAuthority } from "@/lib/admin-mutation-authority";
import { type Topic, listTopics, updateTopic } from "@/lib/preferences-api";
import { qk, STALE } from "@/lib/query-keys";
import { isDuplicateSlug, isValidSlug } from "@/lib/topic-slug";
import { asRoute } from "@/lib/typed-routes";
import { roleCanWrite } from "@/lib/use-admin-gate";

export default function EditTopicPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const queryClient = useQueryClient();
  const [draftTopic, setDraftTopic] = useState<Topic | null>(null);
  const [draftDirty, setDraftDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = meQuery.data?.tenant_id ?? "anon";
  const userId = meQuery.data?.user_id ?? "anon";
  const role = meQuery.data?.viewer_mode
    ? "viewer"
    : meQuery.data
      ? effectiveAuthRole(meQuery.data)
      : null;
  const canAdmin = Boolean(
    meQuery.data && !meQuery.data.viewer_mode && roleCanWrite(role),
  );
  const topicsKey = useMemo(
    () => qk.settings(tenantId, role, "topics"),
    [role, tenantId],
  );
  const topicsQuery = useQuery({
    queryKey: topicsKey,
    queryFn: listTopics,
    enabled: meQuery.isFetched && canAdmin,
    staleTime: STALE.list,
  });
  const foundTopic = topicsQuery.data?.find((t) => t.id === id) ?? null;
  const loading =
    meQuery.isLoading ||
    (canAdmin && topicsQuery.isPending && !topicsQuery.data);
  const loadError =
    canAdmin && topicsQuery.error instanceof Error
      ? topicsQuery.error.message
      : canAdmin && topicsQuery.isError
        ? "Could not load topics — this is a failed request, not a missing topic."
        : null;

  // Register the dirty state with the shared settings guard (SETA-025 idiom).
  useUnsavedChangesGuard(draftDirty && !saving);

  useEffect(() => {
    setDraftTopic(null);
    setDraftDirty(false);
  }, [id, role, tenantId, userId]);

  useEffect(() => {
    if (!draftDirty) setDraftTopic(foundTopic);
  }, [draftDirty, foundTopic]);

  useEffect(() => {
    if (loadError) toast.error(loadError);
  }, [loadError]);

  const updateDraft = (patch: Partial<Topic>): void => {
    if (!canAdmin) return;
    setDraftDirty(true);
    setDraftTopic((cur) => (cur ? { ...cur, ...patch } : cur));
  };

  const slug = draftTopic?.slug.trim() ?? "";
  const nameRequiredError =
    draftTopic && !draftTopic.name.trim() ? "Name is required." : null;
  const slugRequiredError = draftTopic && !slug ? "Slug is required." : null;
  const slugFormatError =
    slug.length > 0 && !isValidSlug(slug)
      ? "Use kebab-case: lowercase letters, numbers, and single dashes."
      : null;
  const slugDuplicateError = isDuplicateSlug(
    slug,
    Array.isArray(topicsQuery.data) ? topicsQuery.data : [],
    id,
  )
    ? "Another topic already uses this slug."
    : null;

  const handleSave = async () => {
    if (!draftTopic || !canAdmin || !meQuery.data || savingRef.current) return;
    if (!draftTopic.slug.trim() || !draftTopic.name.trim()) {
      toast.error("Slug and name are required.");
      return;
    }
    if (slugFormatError || slugDuplicateError) return;
    const snapshot = {
      id: draftTopic.id,
      slug: draftTopic.slug.trim(),
      name: draftTopic.name.trim(),
      description: draftTopic.description ?? "",
      defaultOptIn: draftTopic.defaultOptIn,
    };
    savingRef.current = true;
    setSaving(true);
    try {
      await verifyFreshAdminAuthority(meQuery.data);
      // Send the complete intended state (PATCH-replace safe).
      const updated = await updateTopic(snapshot.id, {
        slug: snapshot.slug,
        name: snapshot.name,
        description: snapshot.description,
        defaultOptIn: snapshot.defaultOptIn,
      });
      queryClient.setQueryData<Topic[]>(topicsKey, (cur) =>
        (cur ?? []).map((candidate) =>
          candidate.id === updated.id ? updated : candidate,
        ),
      );
      void queryClient.invalidateQueries({ queryKey: topicsKey, exact: false });
      setDraftDirty(false);
      toast.success("Topic saved.");
      router.push("/app/settings/topics");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const crumbs = (
    <Breadcrumb
      className="mb-4"
      items={[
        { label: "Settings", href: asRoute("/app/settings") },
        { label: "Topics", href: asRoute("/app/settings/topics") },
        { label: draftTopic?.name ?? "Edit" },
      ]}
    />
  );

  if (loading) {
    return (
      <div className="space-y-4">
        {crumbs}
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-40" />
          </CardHeader>
          <CardContent className="space-y-4">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }
  if (meQuery.isError || (meQuery.isFetched && !meQuery.data)) {
    return (
      <div className="space-y-4">
        {crumbs}
        <Card>
          <CardHeader>
            <CardTitle as="h2">Could not verify access</CardTitle>
            <CardDescription>
              {meQuery.error instanceof Error
                ? meQuery.error.message
                : "Could not verify your topic administration access."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              type="button"
              variant="outline"
              onClick={() => void meQuery.refetch()}
            >
              Retry access check
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }
  if (meQuery.data && !canAdmin) {
    return (
      <div className="space-y-4">
        {crumbs}
        <Card>
          <CardHeader>
            <CardTitle as="h2">Admin access required</CardTitle>
            <CardDescription>
              Topic configuration is read-only for this session. An owner or
              admin outside viewer mode must edit workspace topics.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href="/app/settings/topics">Back to topics</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }
  if (loadError && !draftTopic) {
    return (
      <div className="space-y-4">
        {crumbs}
        <Card>
          <CardHeader>
            <CardTitle as="h2">Could not load topic</CardTitle>
            <CardDescription>{loadError}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              type="button"
              variant="outline"
              onClick={() => void topicsQuery.refetch()}
            >
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }
  if (!draftTopic) {
    return (
      <div className="space-y-4">
        {crumbs}
        <Card>
          <CardHeader>
            <CardTitle as="h2">Topic not found</CardTitle>
            <CardDescription>
              <Link
                className="underline underline-offset-4"
                href="/app/settings/topics"
              >
                Back to topics
              </Link>
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {crumbs}
      <Card>
        <CardHeader>
          {/* The settings shell owns this document's single page-level H1
              ("Topics"). The editor is the nested task within that section. */}
          <CardTitle as="h2">Edit topic</CardTitle>
          <CardDescription className="font-mono text-xs">
            {draftTopic.id}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <form
            className="space-y-5"
            onSubmit={(e) => {
              e.preventDefault();
              void handleSave();
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="t-name">Name</Label>
              <Input
                id="t-name"
                required
                value={draftTopic.name}
                aria-invalid={Boolean(nameRequiredError)}
                aria-describedby={
                  nameRequiredError ? "t-name-error" : undefined
                }
                onChange={(e) => updateDraft({ name: e.target.value })}
              />
              {nameRequiredError ? (
                <p id="t-name-error" className="text-xs text-destructive">
                  {nameRequiredError}
                </p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="t-slug">Slug</Label>
              <Input
                id="t-slug"
                required
                value={draftTopic.slug}
                aria-invalid={Boolean(
                  slugRequiredError || slugFormatError || slugDuplicateError,
                )}
                aria-describedby={
                  slugRequiredError || slugFormatError || slugDuplicateError
                    ? "t-slug-error"
                    : undefined
                }
                onChange={(e) => updateDraft({ slug: e.target.value })}
              />
              {slugRequiredError || slugFormatError || slugDuplicateError ? (
                <p id="t-slug-error" className="text-xs text-destructive">
                  {slugRequiredError ?? slugFormatError ?? slugDuplicateError}
                </p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="t-desc">Description</Label>
              <Input
                id="t-desc"
                value={draftTopic.description ?? ""}
                onChange={(e) => updateDraft({ description: e.target.value })}
              />
            </div>
            <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
              <Checkbox
                checked={draftTopic.defaultOptIn}
                onChange={(e) =>
                  updateDraft({ defaultOptIn: e.target.checked })
                }
              />
              Default to opted-in for new subscribers
            </label>
            <div className="flex flex-wrap items-center gap-3 pt-2">
              <Button
                type="submit"
                disabled={
                  saving ||
                  Boolean(nameRequiredError) ||
                  Boolean(slugRequiredError) ||
                  Boolean(slugFormatError) ||
                  Boolean(slugDuplicateError)
                }
              >
                {saving ? "Saving…" : "Save"}
              </Button>
              <Button asChild variant="ghost" type="button">
                <Link href="/app/settings/topics">Cancel</Link>
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
