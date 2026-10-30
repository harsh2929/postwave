// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { use } from "react";

import { ListDetailWorkspace } from "./_components/list-detail-workspace";

export default function ListDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return <ListDetailWorkspace rawId={id} />;
}
