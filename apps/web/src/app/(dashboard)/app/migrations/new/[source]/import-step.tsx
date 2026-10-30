// SPDX-License-Identifier: AGPL-3.0-only
import { type ComponentProps, type ReactElement, useCallback } from "react";
import { toast } from "sonner";

import type { MigrationStreamDone } from "@/lib/migration-progress-api";
import {
  SOURCE_LABELS,
  type MigrationJob,
  type SourcePlatform,
} from "@/lib/types";
import { MigrationProgressView } from "../../_progress-view";

export interface ImportStepState {
  jobId: string;
  job: MigrationJob | null;
}

type ProgressViewProps = ComponentProps<typeof MigrationProgressView>;
type ProgressViewComponent = (props: ProgressViewProps) => ReactElement;

interface ImportStepProps {
  source: SourcePlatform;
  state: ImportStepState;
  onComplete: (job: MigrationJob) => void;
  progressView?: ProgressViewComponent;
  beforeWrite: (signal?: AbortSignal) => Promise<void>;
  authorityKey: string;
}

export function ImportStep({
  source,
  state,
  onComplete,
  progressView: ProgressView = MigrationProgressView,
  beforeWrite,
  authorityKey,
}: ImportStepProps) {
  const handleComplete = useCallback(
    (done: MigrationStreamDone) => {
      if (done.status === "completed") {
        toast.success("Migration complete");
      } else if (done.status === "failed") {
        toast.error("Migration failed", {
          description: done.error ?? "Unknown error",
        });
      } else if (done.status === "rolled_back") {
        toast.info("Migration rolled back");
      }
      const job = done.job as MigrationJob;
      if (job && job.id) onComplete(job);
    },
    [onComplete],
  );

  return (
    <ProgressView
      jobId={state.jobId}
      sourceLabel={SOURCE_LABELS[source]}
      source={source}
      onComplete={handleComplete}
      beforeWrite={beforeWrite}
      authorityKey={authorityKey}
    />
  );
}
