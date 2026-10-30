// SPDX-License-Identifier: AGPL-3.0-only

import { isMailchimpSource } from "@/lib/migration-audience-selection";
import type { MigrationJob } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function SelectedAudienceScopeCard({ job }: { job: MigrationJob }) {
  if (!isMailchimpSource(job.source)) return null;
  if (!job.selected_audience_ids?.length) {
    return (
      <Card className="border-destructive/50">
        <CardHeader>
          <CardTitle className="text-base">
            Mailchimp audience scope missing
          </CardTitle>
          <CardDescription>
            No explicit audience IDs are recorded for this job. Do not commit or
            treat its resource totals as audience-scoped; return to discovery
            and select at least one audience.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Mailchimp audience scope</CardTitle>
        <CardDescription>
          This migration used {job.selected_audience_ids.length} selected
          audience{job.selected_audience_ids.length === 1 ? "" : "s"} for
          audience-bound records.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {job.selected_audience_ids.map((id) => (
            <Badge key={id} variant="secondary">
              {id}
            </Badge>
          ))}
        </div>
        <div className="space-y-1 text-xs text-muted-foreground">
          <p>
            Scoped: members and merge data, groups/interests, segments,
            signup-form and audience-schema evidence, list-triggered Classic
            Automations, campaigns, and reports.
          </p>
          <p>
            Account-global: templates, landing pages, ecommerce evidence, and
            other source-archive evidence may still include records outside
            those audiences.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
