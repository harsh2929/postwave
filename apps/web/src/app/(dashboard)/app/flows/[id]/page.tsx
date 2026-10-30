// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";
import { useParams } from "next/navigation";

const FlowEditor = dynamic(
  () =>
    import("../_components/flow-editor").then((module) => module.FlowEditor),
  {
    ssr: false,
    loading: () => <FlowEditorLoading />,
  },
);

export default function FlowEditorPage() {
  const params = useParams<{ id: string }>();
  if (!params?.id) return null;
  // Key by id so switching between two flows in-app remounts the editor and
  // re-seeds its local AST state (the seed runs once per mount).
  return <FlowEditor key={params.id} flowId={params.id} />;
}

function FlowEditorLoading() {
  return (
    <div
      className="space-y-4 p-6"
      role="status"
      aria-live="polite"
      aria-label="Loading flow editor"
    >
      <span className="sr-only">
        Loading the flow editor and its current automation graph…
      </span>
      <div className="h-8 w-48 animate-pulse rounded bg-muted motion-reduce:animate-none" />
      <div className="h-[32rem] animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
    </div>
  );
}
