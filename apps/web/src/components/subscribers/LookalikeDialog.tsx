// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2, UsersRound } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { apiErrorMessage } from "@/lib/api";
import { base, STALE } from "@/lib/query-keys";
import { listSegments } from "@/lib/segments-api";
import {
  createLookalikeAudience,
  deleteLookalikeAudience,
  exportLookalikeAudience,
  isTerminalLookalike,
  listAudienceDestinations,
  listLookalikeAudiences,
  lookalikeInputProblem,
  waitForLookalikeTerminal,
  type LookalikeAudience,
} from "@/lib/subscriber-directory-api";

import { useDirectoryIdentity } from "./directory-context";

const MIN_SEED_MEMBERS = 50;
const RECENT_LIMIT = 5;

function defaultName(selectedCount: number): string {
  return selectedCount > 0
    ? `Lookalike of ${selectedCount.toLocaleString()} selected`
    : "Lookalike audience";
}

function statusLabel(audience: LookalikeAudience): string {
  switch (audience.status) {
    case "ready":
      return `Ready · ${audience.memberCount.toLocaleString()} of ${audience.sizeRequested.toLocaleString()} modeled from ${audience.seedCount.toLocaleString()} seed members`;
    case "failed":
      return audience.error || "The model could not finish. Review the seed and generate again.";
    default:
      return "Generating…";
  }
}

/**
 * Generate a first-party modeled audience from an evaluated seed segment
 * (POST /api/v1/subscribers/lookalike), poll it to a terminal state, record an
 * export destination, and delete modeled audiences. Generation, export and
 * delete need `write:subscribers`; viewers see the list read-only.
 */
export function LookalikeDialog({ selectedCount = 0 }: { selectedCount?: number }) {
  const identity = useDirectoryIdentity();
  const queryClient = useQueryClient();
  const ids = {
    seed: useId(),
    name: useId(),
    size: useId(),
    floor: useId(),
    ack: useId(),
    destination: useId(),
  };
  const [open, setOpen] = useState(false);
  const [seedId, setSeedId] = useState("");
  const [name, setName] = useState(defaultName(selectedCount));
  const [size, setSize] = useState("1000");
  const [useFloor, setUseFloor] = useState(true);
  const [floor, setFloor] = useState("0.8");
  const [acknowledged, setAcknowledged] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LookalikeAudience | null>(null);
  const [destinationId, setDestinationId] = useState("");
  const [exporting, setExporting] = useState(false);
  const pollRef = useRef<AbortController | null>(null);

  const key = base("subscriber-lookalikes", identity.tenantId, identity.role);
  const segments = useQuery({
    queryKey: [...base("segments", identity.tenantId, identity.role), "lookalike-seeds"],
    queryFn: () => listSegments(),
    enabled: open && identity.ready,
    staleTime: STALE.list,
  });
  const audiences = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => listLookalikeAudiences(signal),
    enabled: open && identity.ready,
    staleTime: STALE.list,
  });
  const destinations = useQuery({
    queryKey: base("audience-destinations", identity.tenantId, identity.role),
    queryFn: ({ signal }) => listAudienceDestinations(signal),
    enabled: open && identity.ready,
    staleTime: STALE.list,
  });

  useEffect(() => () => pollRef.current?.abort(), []);

  const seeds = (Array.isArray(segments.data) ? segments.data : []).filter(
    (segment) =>
      segment.lastCount === null ||
      segment.lastCount === undefined ||
      segment.lastCount >= MIN_SEED_MEMBERS,
  );
  const input = {
    name,
    seedSegmentId: seedId,
    size: Number(size),
    confidenceThreshold: useFloor ? Number(floor) : null,
  };
  const problem = lookalikeInputProblem(input);
  const blocked = !identity.canWrite
    ? "Generating a lookalike needs an owner, admin or editor role."
    : problem ?? (!acknowledged ? "Acknowledge the data-use notice first." : null);

  const generate = async (event: FormEvent) => {
    event.preventDefault();
    if (blocked || generating) return;
    setGenerating(true);
    setError(null);
    setResult(null);
    pollRef.current?.abort();
    const controller = new AbortController();
    pollRef.current = controller;
    try {
      let audience = await createLookalikeAudience(input, {
        signal: controller.signal,
      });
      setResult(audience);
      if (!isTerminalLookalike(audience.status)) {
        audience = await waitForLookalikeTerminal(audience, {
          signal: controller.signal,
          onProgress: setResult,
        });
        setResult(audience);
      }
      await queryClient.invalidateQueries({ queryKey: key });
      if (audience.status === "ready") toast.success("Lookalike audience generated.");
      else toast.error("The lookalike model failed.");
    } catch (err) {
      if (!controller.signal.aborted)
        setError(apiErrorMessage(err, "Could not generate the lookalike audience."));
    } finally {
      setGenerating(false);
    }
  };

  const exportResult = async () => {
    if (!result || !destinationId || exporting) return;
    setExporting(true);
    setError(null);
    try {
      const updated = await exportLookalikeAudience(result.id, destinationId);
      setResult(updated);
      await queryClient.invalidateQueries({ queryKey: key });
      toast.success("Destination recorded for this audience.");
    } catch (err) {
      setError(apiErrorMessage(err, "Could not record the destination."));
    } finally {
      setExporting(false);
    }
  };

  const remove = async (audience: LookalikeAudience) => {
    try {
      await deleteLookalikeAudience(audience.id);
      if (result?.id === audience.id) setResult(null);
      await queryClient.invalidateQueries({ queryKey: key });
      toast.success(`Deleted “${audience.name}”.`);
    } catch (err) {
      toast.error(apiErrorMessage(err, "Could not delete the modeled audience."));
      throw err;
    }
  };

  const recent = (Array.isArray(audiences.data) ? audiences.data : []).slice(0, RECENT_LIMIT);
  const destinationList = Array.isArray(destinations.data) ? destinations.data : [];
  const destinationName = (id: string | null) =>
    destinationList.find((destination) => destination.id === id)?.provider ?? id;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) pollRef.current?.abort();
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-9">
          <UsersRound aria-hidden className="h-4 w-4" />
          Lookalike
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Generate a lookalike audience</DialogTitle>
          <DialogDescription>
            Build a first-party modeled audience from one evaluated seed
            segment with at least {MIN_SEED_MEMBERS} live members.
          </DialogDescription>
        </DialogHeader>

        <form className="grid gap-3" onSubmit={generate} noValidate>
          <div className="grid gap-1.5">
            <Label htmlFor={ids.seed}>Seed segment</Label>
            <Select
              id={ids.seed}
              value={seedId}
              disabled={!identity.canWrite || generating}
              onChange={(event) => setSeedId(event.target.value)}
            >
              <option value="">
                {segments.isPending
                  ? "Loading segments…"
                  : segments.isError
                    ? "Segments unavailable"
                    : seeds.length === 0
                      ? `No segment has ${MIN_SEED_MEMBERS}+ members`
                      : "Choose a seed segment…"}
              </option>
              {seeds.map((segment) => (
                <option key={segment.id} value={segment.id}>
                  {segment.name}
                  {typeof segment.lastCount === "number"
                    ? ` (${segment.lastCount.toLocaleString()})`
                    : " (not yet counted)"}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={ids.name}>Name</Label>
            <Input
              id={ids.name}
              value={name}
              maxLength={120}
              disabled={!identity.canWrite || generating}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor={ids.size}>Audience size</Label>
              <Input
                id={ids.size}
                type="number"
                min={100}
                max={10_000}
                step={100}
                value={size}
                disabled={!identity.canWrite || generating}
                onChange={(event) => setSize(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={ids.floor}>Confidence floor</Label>
              <Input
                id={ids.floor}
                type="number"
                min={0.5}
                max={1}
                step={0.05}
                value={floor}
                disabled={!identity.canWrite || generating || !useFloor}
                onChange={(event) => setFloor(event.target.value)}
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 accent-primary"
              checked={useFloor}
              disabled={!identity.canWrite || generating}
              onChange={(event) => setUseFloor(event.target.checked)}
            />
            Only include candidates above the confidence floor
          </label>
          <label
            htmlFor={ids.ack}
            className="flex items-start gap-2 rounded-md border p-3 text-sm"
          >
            <input
              id={ids.ack}
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-primary"
              checked={acknowledged}
              disabled={!identity.canWrite || generating}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            <span>
              I confirm this workspace may use its own first-party subscriber
              data (email domain, signup source, engagement, retention) to model
              this audience.
            </span>
          </label>
          {blocked && identity.ready ? (
            <p className="text-xs text-muted-foreground">{blocked}</p>
          ) : null}
          <Button type="submit" disabled={Boolean(blocked) || generating}>
            {generating ? "Generating…" : "Generate lookalike"}
          </Button>
        </form>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {result ? (
          <section
            aria-label="Generated audience"
            className="grid gap-2 rounded-md border p-3 text-sm"
          >
            <div className="flex items-center gap-2">
              <span className="font-medium">{result.name}</span>
              <Badge variant={result.status === "failed" ? "destructive" : "secondary"}>
                {result.status}
              </Badge>
            </div>
            <p role="status" className="text-muted-foreground">
              {statusLabel(result)}
            </p>
            {result.status === "ready" && identity.canWrite ? (
              <div className="flex flex-wrap items-end gap-2">
                <div className="grid gap-1.5">
                  <Label htmlFor={ids.destination}>Export destination</Label>
                  <Select
                    id={ids.destination}
                    value={destinationId}
                    disabled={exporting}
                    onChange={(event) => setDestinationId(event.target.value)}
                    className="w-52"
                  >
                    <option value="">
                      {destinations.isError
                        ? "Destinations unavailable"
                        : destinationList.length === 0
                          ? "No connected destinations"
                          : "Choose a destination…"}
                    </option>
                    {destinationList.map((destination) => (
                      <option key={destination.id} value={destination.id}>
                        {destination.provider} · {destination.status}
                      </option>
                    ))}
                  </Select>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={!destinationId || exporting}
                  onClick={() => void exportResult()}
                >
                  {exporting ? "Recording…" : "Export"}
                </Button>
              </div>
            ) : null}
            {result.exportedDestinationId ? (
              <p className="text-xs text-muted-foreground">
                Destination recorded: {destinationName(result.exportedDestinationId)}.
                Delivery to the ad platform is not started from here.
              </p>
            ) : null}
          </section>
        ) : null}

        <section aria-label="Recent modeled audiences" className="grid gap-2">
          <h3 className="text-sm font-medium">Recent modeled audiences</h3>
          {audiences.isPending ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading…
            </p>
          ) : audiences.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {apiErrorMessage(audiences.error, "Could not load modeled audiences.")}
            </p>
          ) : recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">None yet.</p>
          ) : (
            <ul className="grid gap-1.5">
              {recent.map((audience) => (
                <li
                  key={audience.id}
                  className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm"
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left underline-offset-2 hover:underline"
                    onClick={() => setResult(audience)}
                  >
                    {audience.name}
                  </button>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {audience.status === "ready"
                      ? audience.memberCount.toLocaleString()
                      : audience.status}
                  </span>
                  {identity.canWrite ? (
                    <ConfirmDialog
                      title={`Delete “${audience.name}”?`}
                      description="The modeled audience and its member scores are deleted. Seed segments and subscribers are not changed."
                      confirmLabel="Delete audience"
                      confirmVariant="destructive"
                      onConfirm={() => remove(audience)}
                      trigger={
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={`Delete modeled audience ${audience.name}`}
                        >
                          <Trash2 aria-hidden className="h-4 w-4" />
                        </Button>
                      }
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </DialogContent>
    </Dialog>
  );
}
