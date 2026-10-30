// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import dynamic from "next/dynamic";

const CustomObjectsClient = dynamic(
  () =>
    import("./custom-objects-client").then(
      (module) => module.CustomObjectsClient,
    ),
  {
    ssr: false,
    loading: () => <RouteClientFallback label="custom-object workspace" />,
  },
);

function RouteClientFallback({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-busy="true"
      className="mx-auto min-h-48 max-w-6xl p-6 text-sm text-muted-foreground"
    >
      Custom objects — Loading the protected {label}…
    </div>
  );
}

export default function CustomObjectsPage() {
  return <CustomObjectsClient />;
}
