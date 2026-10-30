// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Review-widget authoring — the one-shot POST /api/v1/reviews/widgets form.
 *
 * Desktop reference: components/reviews/WidgetsTab.tsx withholds authoring
 * entirely behind the "Widget authoring is review-gated" notice. Web builds
 * the full verb and gates it the same way: while
 * REVIEW_WIDGET_AUTHORING_AVAILABLE is false every control stays visible but
 * disabled, described by the policy's own sentence, and no request leaves the
 * browser (the transport refuses as well). When the flag lifts, the form
 * creates a widget and refreshes the inventory beside it.
 */
import { useId, useRef, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { apiErrorMessage } from "@/lib/api";
import {
  createReviewWidget,
  REVIEW_WIDGET_STATUSES,
  REVIEW_WIDGET_TYPES,
  type ReviewWidgetInput,
} from "@/lib/reviews-api";
import { widgetTypeLabel } from "@/lib/reviews-helpers";
import {
  REVIEW_WIDGET_AUTHORING_AVAILABLE,
  REVIEW_WIDGET_AUTHORING_UNAVAILABLE_REASON,
} from "@/lib/reviews-operational-availability";

const NAME_MAX = 120;

export function ReviewWidgetAuthoring({
  canAdmin,
  widgetTypes,
  keyBase,
}: {
  canAdmin: boolean;
  /** Server-advertised renderer labels (catalog.widget_types), or null. */
  widgetTypes: readonly string[] | null;
  keyBase: readonly unknown[];
}) {
  const queryClient = useQueryClient();
  const guard = useRef(false);
  const noteId = useId();
  const fieldId = useId();
  const held = !REVIEW_WIDGET_AUTHORING_AVAILABLE;
  const canAuthor = canAdmin && !held;
  const describedBy = canAuthor ? undefined : noteId;

  const typeOptions =
    widgetTypes && widgetTypes.length > 0 ? widgetTypes : REVIEW_WIDGET_TYPES;

  const [name, setName] = useState("");
  const [widgetType, setWidgetType] = useState<string>(
    typeOptions.includes("product_reviews") ? "product_reviews" : typeOptions[0],
  );
  const [status, setStatus] = useState<string>("draft");
  const [language, setLanguage] = useState("en");

  const mutation = useMutation({
    mutationFn: (input: ReviewWidgetInput) => createReviewWidget(input),
    onSuccess: (widget) => {
      toast.success(
        `Widget “${widget.name}” created as ${widget.status.replace(/_/gu, " ")}.`,
      );
      setName("");
      void queryClient
        .invalidateQueries({ queryKey: [...keyBase, "widgets"] })
        .catch(() => undefined);
    },
    onSettled: () => {
      guard.current = false;
    },
  });

  const trimmedName = name.trim();
  const formValid = trimmedName.length > 0 && trimmedName.length <= NAME_MAX;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canAuthor || !formValid || guard.current) return;
    guard.current = true;
    mutation.mutate({
      name: trimmedName,
      widget_type: widgetType,
      status,
      language: language.trim() || undefined,
    });
  }

  return (
    <section
      aria-labelledby={`${fieldId}-title`}
      className="mb-6 space-y-4 rounded-lg border bg-background/60 p-4"
    >
      <div>
        <h3 id={`${fieldId}-title`} className="text-sm font-medium">
          Create review widget
        </h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          A widget is created once in the lifecycle state you choose; the
          service exposes no later edit or transition command.
        </p>
      </div>

      {held ? (
        <Alert variant="warning" role="note" id={noteId}>
          <AlertTitle>Widget authoring is review-gated</AlertTitle>
          <AlertDescription>
            {REVIEW_WIDGET_AUTHORING_UNAVAILABLE_REASON}
            {canAdmin
              ? " An administrator can monitor the inventory while the complete lifecycle is implemented."
              : " Your current role is read-only."}
          </AlertDescription>
        </Alert>
      ) : !canAdmin ? (
        <p id={noteId} role="note" className="text-xs text-muted-foreground">
          Only workspace owners and admins can create review widgets.
        </p>
      ) : null}

      <form className="space-y-4" onSubmit={onSubmit} noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor={`${fieldId}-name`}>Widget name</Label>
            <Input
              id={`${fieldId}-name`}
              value={name}
              maxLength={NAME_MAX}
              required
              autoComplete="off"
              placeholder="Storefront stars"
              disabled={!canAuthor || mutation.isPending}
              aria-describedby={describedBy}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${fieldId}-type`}>Renderer type</Label>
            <Select
              id={`${fieldId}-type`}
              value={widgetType}
              disabled={!canAuthor || mutation.isPending}
              aria-describedby={describedBy}
              onChange={(event) => setWidgetType(event.target.value)}
            >
              {typeOptions.map((option) => (
                <option key={option} value={option}>
                  {widgetTypeLabel(option)}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${fieldId}-status`}>Lifecycle state</Label>
            <Select
              id={`${fieldId}-status`}
              value={status}
              disabled={!canAuthor || mutation.isPending}
              aria-describedby={describedBy}
              onChange={(event) => setStatus(event.target.value)}
            >
              {REVIEW_WIDGET_STATUSES.map((option) => (
                <option key={option} value={option} className="capitalize">
                  {option}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${fieldId}-language`}>Language</Label>
            <Input
              id={`${fieldId}-language`}
              value={language}
              maxLength={16}
              autoComplete="off"
              placeholder="en"
              disabled={!canAuthor || mutation.isPending}
              aria-describedby={describedBy}
              onChange={(event) => setLanguage(event.target.value)}
            />
          </div>
        </div>

        {mutation.isError ? (
          <Alert variant="destructive" role="alert">
            <AlertTitle>The widget was not created</AlertTitle>
            <AlertDescription>
              {apiErrorMessage(
                mutation.error,
                "The service did not accept the widget.",
              )}
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="flex justify-end">
          <Button
            type="submit"
            className="min-h-11 w-full sm:min-h-9 sm:w-auto"
            loading={mutation.isPending}
            disabled={!canAuthor || !formValid}
            aria-describedby={describedBy}
          >
            Create widget
          </Button>
        </div>
      </form>
    </section>
  );
}
