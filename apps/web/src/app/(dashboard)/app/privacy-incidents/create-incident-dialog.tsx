// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiErrorMessage } from "@/lib/api";
import { whoami } from "@/lib/auth-api";
import { newUUIDv7 } from "@/lib/http-fetch";
import {
  authorizePrivacyIncidentAdmin,
  createPrivacyIncident,
  isAmbiguousPrivacyIncidentMutation,
  type PrivacyIncident,
  type PrivacyIncidentCreateInput,
  type PrivacyIncidentSeverity,
  type PrivacyJurisdictionReference,
} from "@/lib/privacy-incidents-api";
import { qk } from "@/lib/query-keys";
import {
  datetimeLocalToISO,
  nowDatetimeLocal,
  parseIncidentList,
} from "./incident-presenters";

interface CreateIncidentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: string;
  userId: string;
  knownJurisdictions: readonly PrivacyJurisdictionReference[];
  inventoryReady: boolean;
  onCreated: (incident: PrivacyIncident) => Promise<void> | void;
}

function combinedSummary(title: string, description: string): string {
  return description.trim()
    ? `${title.trim()}\n\n${description.trim()}`
    : title.trim();
}

function validateList(values: readonly string[], label: string): string | null {
  if (values.length > 64) return `${label} accepts at most 64 entries.`;
  if (values.some((value) => Array.from(value).length > 256)) {
    return `Each ${label.toLocaleLowerCase()} entry must be 256 characters or fewer.`;
  }
  return null;
}

export function CreateIncidentDialog({
  open,
  onOpenChange,
  tenantId,
  userId,
  knownJurisdictions,
  inventoryReady,
  onCreated,
}: CreateIncidentDialogProps) {
  const queryClient = useQueryClient();
  const idempotencyKey = useRef(newUUIDv7());
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState<PrivacyIncidentSeverity>("medium");
  const [detectedAt, setDetectedAt] = useState(nowDatetimeLocal);
  const [discoveredAt, setDiscoveredAt] = useState("");
  const [regions, setRegions] = useState("");
  const [categories, setCategories] = useState("unknown");
  const [jurisdictions, setJurisdictions] = useState("");
  const [selectedJurisdictions, setSelectedJurisdictions] = useState<
    Set<string>
  >(new Set());
  const [subjectCount, setSubjectCount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ambiguousFingerprint, setAmbiguousFingerprint] = useState<
    string | null
  >(null);

  const locked = ambiguousFingerprint !== null;

  const resetDraft = () => {
    idempotencyKey.current = newUUIDv7();
    setTitle("");
    setDescription("");
    setSeverity("medium");
    setDetectedAt(nowDatetimeLocal());
    setDiscoveredAt("");
    setRegions("");
    setCategories("unknown");
    setJurisdictions("");
    setSelectedJurisdictions(new Set());
    setSubjectCount("");
    setError(null);
    setAmbiguousFingerprint(null);
  };

  const currentAuthority = async () => {
    const current = await whoami();
    queryClient.setQueryData(["whoami"], current);
    queryClient.setQueryData(qk.authMe(), current);
    return authorizePrivacyIncidentAdmin(current, tenantId, userId);
  };

  const buildInput = (): PrivacyIncidentCreateInput | null => {
    const summary = combinedSummary(title, description);
    if (!title.trim()) {
      setError("Enter a short incident title.");
      return null;
    }
    if (Array.from(summary).length > 4_000) {
      setError(
        "Title and description together must be 4,000 characters or fewer.",
      );
      return null;
    }
    const detected = datetimeLocalToISO(detectedAt);
    const discovered = discoveredAt ? datetimeLocalToISO(discoveredAt) : null;
    if (!detected) {
      setError("Enter a valid detection date and time.");
      return null;
    }
    if (discoveredAt && !discovered) {
      setError("Enter a valid discovery date and time, or leave it blank.");
      return null;
    }
    const futureLimit = Date.now() + 5 * 60_000;
    if (
      Date.parse(detected) > futureLimit ||
      (discovered && Date.parse(discovered) > futureLimit)
    ) {
      setError(
        "Incident times cannot be more than five minutes in the future.",
      );
      return null;
    }
    const regionList = parseIncidentList(regions);
    const categoryList = parseIncidentList(categories);
    const jurisdictionList = parseIncidentList(
      [...selectedJurisdictions, jurisdictions].join(","),
    );
    for (const [values, label] of [
      [regionList, "Affected regions"],
      [categoryList, "Data categories"],
      [jurisdictionList, "Jurisdictions"],
    ] as const) {
      const failure = validateList(values, label);
      if (failure) {
        setError(failure);
        return null;
      }
    }
    let affectedSubjectCount: number | null = null;
    if (subjectCount.trim()) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(subjectCount.trim())) {
        setError(
          "Affected subjects must be a whole number from 0 to 2,147,483,647.",
        );
        return null;
      }
      affectedSubjectCount = Number(subjectCount.trim());
      if (
        !Number.isSafeInteger(affectedSubjectCount) ||
        affectedSubjectCount > 2_147_483_647
      ) {
        setError(
          "Affected subjects must be a whole number from 0 to 2,147,483,647.",
        );
        return null;
      }
    }
    return {
      severity,
      summary,
      detected_at: detected,
      discovered_at: discovered,
      affected_regions: regionList,
      affected_data_categories: categoryList,
      affected_subject_count: affectedSubjectCount,
      jurisdictions: jurisdictionList,
    };
  };

  const submit = async () => {
    setError(null);
    if (!inventoryReady) {
      setError(
        "Refresh the verified incident register before opening a record. No request was sent.",
      );
      return;
    }
    const incident = buildInput();
    if (!incident) return;
    const fingerprint = JSON.stringify(incident);
    if (ambiguousFingerprint !== null && ambiguousFingerprint !== fingerprint) {
      setError(
        "The previous outcome is unknown. Restore the exact attempted fields or discard only after checking the register.",
      );
      return;
    }
    setSubmitting(true);
    let requestStarted = false;
    try {
      const authority = await currentAuthority();
      requestStarted = true;
      const created = await createPrivacyIncident({
        authority,
        incident,
        idempotencyKey: idempotencyKey.current,
      });
      try {
        await currentAuthority();
      } catch {
        await onCreated(created);
        resetDraft();
        onOpenChange(false);
        toast.warning(
          "Incident created before your workspace identity changed",
          {
            description:
              "The exact server record was verified, but the previous workspace view was retired.",
          },
        );
        return;
      }
      await onCreated(created);
      resetDraft();
      onOpenChange(false);
      toast.success("Preliminary incident record created");
    } catch (cause) {
      if (requestStarted && isAmbiguousPrivacyIncidentMutation(cause)) {
        setAmbiguousFingerprint(fingerprint);
        setError(
          "The create request may have reached the service, but no exact receipt was available. Fields are locked and the same request key will be reused. Check the register before discarding.",
        );
      } else {
        if (requestStarted) idempotencyKey.current = newUUIDv7();
        setError(
          requestStarted
            ? apiErrorMessage(
                cause,
                "The preliminary incident record could not be created. No verified receipt was returned.",
              )
            : `${apiErrorMessage(cause, "Reauthorization failed")} No write request was sent.`,
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-2xl"
        closeDisabled={submitting}
        aria-busy={submitting}
      >
        <DialogHeader>
          <DialogTitle>New preliminary privacy incident</DialogTitle>
          <DialogDescription>
            Record operational facts only. This form does not determine legal
            duties, notification audiences, deadlines, or closure readiness.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Record not confirmed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <fieldset disabled={submitting || locked} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="privacy-incident-title">Incident title</Label>
            <Input
              id="privacy-incident-title"
              value={title}
              maxLength={4_000}
              required
              autoFocus
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="privacy-incident-description">
              Preliminary description
            </Label>
            <Textarea
              id="privacy-incident-description"
              value={description}
              maxLength={4_000}
              rows={4}
              onChange={(event) => setDescription(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Title and description share the 4,000-character server limit.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="privacy-incident-severity">Severity</Label>
              <select
                id="privacy-incident-severity"
                className="w-full rounded-md border border-input bg-background px-3"
                value={severity}
                onChange={(event) =>
                  setSeverity(event.target.value as PrivacyIncidentSeverity)
                }
              >
                <option value="investigating">Investigating</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="privacy-incident-subjects">
                Affected subjects (estimate)
              </Label>
              <Input
                id="privacy-incident-subjects"
                inputMode="numeric"
                value={subjectCount}
                placeholder="Unknown"
                onChange={(event) => setSubjectCount(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="privacy-incident-detected">Detected at</Label>
              <Input
                id="privacy-incident-detected"
                type="datetime-local"
                value={detectedAt}
                required
                onChange={(event) => setDetectedAt(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="privacy-incident-discovered">
                Discovered at (optional)
              </Label>
              <Input
                id="privacy-incident-discovered"
                type="datetime-local"
                value={discoveredAt}
                onChange={(event) => setDiscoveredAt(event.target.value)}
              />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="privacy-incident-regions">Affected regions</Label>
              <Textarea
                id="privacy-incident-regions"
                value={regions}
                placeholder="One per line or comma-separated"
                rows={3}
                onChange={(event) => setRegions(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="privacy-incident-categories">
                Affected data categories
              </Label>
              <Textarea
                id="privacy-incident-categories"
                value={categories}
                placeholder="One per line or comma-separated"
                rows={3}
                onChange={(event) => setCategories(event.target.value)}
              />
            </div>
          </div>
          <div className="space-y-3">
            <Label asChild>
              <span>Candidate jurisdictions</span>
            </Label>
            <p className="text-xs leading-5 text-muted-foreground">
              Catalog choices are capture aids only and do not determine which
              law applies.
            </p>
            <div className="grid gap-2 rounded-lg border p-3 sm:grid-cols-2">
              {knownJurisdictions.map((jurisdiction) => (
                <label
                  key={jurisdiction.code}
                  className="flex min-h-9 items-center gap-2 text-sm"
                >
                  <Checkbox
                    checked={selectedJurisdictions.has(jurisdiction.code)}
                    onChange={(event) => {
                      const next = new Set(selectedJurisdictions);
                      if (event.currentTarget.checked)
                        next.add(jurisdiction.code);
                      else next.delete(jurisdiction.code);
                      setSelectedJurisdictions(next);
                    }}
                  />
                  <span>
                    {jurisdiction.code} — {jurisdiction.name}
                  </span>
                </label>
              ))}
            </div>
            <div className="space-y-2">
              <Label htmlFor="privacy-incident-other-jurisdictions">
                Other candidate jurisdiction codes
              </Label>
              <Input
                id="privacy-incident-other-jurisdictions"
                value={jurisdictions}
                placeholder="One per line or comma-separated"
                onChange={(event) => setJurisdictions(event.target.value)}
              />
            </div>
          </div>
        </fieldset>

        {locked ? (
          <Alert variant="warning">
            <AlertTitle>Exact retry lock active</AlertTitle>
            <AlertDescription>
              Retry sends the same payload with the same idempotency key. To
              abandon it, first check the incident register for this record.
            </AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter>
          {locked ? (
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={() => {
                if (
                  window.confirm(
                    "Only discard after checking the register for the possibly-created incident. Discard this exact retry key?",
                  )
                ) {
                  resetDraft();
                  onOpenChange(false);
                }
              }}
            >
              Discard after checking
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={() => onOpenChange(false)}
            >
              Keep draft and close
            </Button>
          )}
          <Button
            type="button"
            loading={submitting}
            onClick={() => void submit()}
          >
            {locked ? "Retry exact request" : "Create preliminary record"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
