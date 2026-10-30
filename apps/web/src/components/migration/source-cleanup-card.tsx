// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { removeMigrationSourceData } from "@/lib/migration-api";
import { SOURCE_LABELS, type MigrationJob } from "@/lib/types";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardFooter,
} from "@/components/ui/card";

export function SourceCleanupCard({
  job,
  authorityKey,
  beforeWrite,
  onRemoved,
}: {
  job: MigrationJob;
  authorityKey: string;
  beforeWrite: (signal?: AbortSignal) => Promise<void>;
  onRemoved: (job: MigrationJob) => void;
}) {
  const [pending, setPending] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [removed, setRemoved] = useState(false);
  const operation = useRef<AbortController | null>(null);
  useEffect(() => {
    setPending(false);
    setConfirmed(false);
    setRemoved(false);
    return () => {
      operation.current?.abort();
      operation.current = null;
    };
  }, [authorityKey, job.id]);
  const remove = async () => {
    if (operation.current || !confirmed) return;
    const controller = new AbortController();
    operation.current = controller;
    setPending(true);
    try {
      await beforeWrite(controller.signal);
      controller.signal.throwIfAborted();
      const response = await removeMigrationSourceData(
        job.id,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      setRemoved(true);
      onRemoved(response.job);
      toast.success("Saved migration source data removed");
    } catch (error) {
      if (!controller.signal.aborted)
        toast.error("Could not remove source data", {
          description:
            error instanceof Error ? error.message : "Please try again.",
        });
    } finally {
      if (operation.current === controller) {
        operation.current = null;
        if (!controller.signal.aborted) setPending(false);
      }
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Finish source cleanup</CardTitle>
        <CardDescription>
          {removed
            ? "Saved credentials and uploaded source files have been removed. "
            : "Remove saved credentials and uploaded source files, and stop migration monitoring. Finish your source checks first. You’ll need to reconnect or upload a new file to read the source again. "}
          To end access at {SOURCE_LABELS[job.source]}, also revoke the
          migration key or disconnect the authorized app in that account, if you
          connected one.
        </CardDescription>
      </CardHeader>
      {!removed && (
        <CardFooter className="flex flex-col items-start gap-3">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={pending}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            I’ve finished the source checks and want to remove the saved source
            data.
          </label>
          <Button
            variant="outline"
            disabled={pending || !confirmed}
            onClick={() => void remove()}
          >
            {pending ? "Removing…" : "Remove saved source data"}
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}
