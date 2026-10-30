// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * The sequence header's presence badge, copy-link button and last-viewed
 * recorder. These are shared components; this wrapper exists so page.tsx can
 * load them on demand rather than carrying their realtime and activity
 * clients in the route's initial graph.
 */

import { CopyEntityLink } from "@/components/copy-entity-link";
import { EntityPresence, entityRefFor } from "@/components/entity-presence";
import { RecordLastViewed } from "@/components/record-last-viewed";

export function SequenceDetailHeaderTools({
  sequenceId,
}: {
  sequenceId: string;
}) {
  return (
    <>
      <EntityPresence entityRef={entityRefFor("sequence", sequenceId)} />
      <CopyEntityLink entity="sequence" id={sequenceId} />
      <RecordLastViewed entity="sequence" id={sequenceId} />
    </>
  );
}
