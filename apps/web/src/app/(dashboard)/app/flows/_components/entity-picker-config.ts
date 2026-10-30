// SPDX-License-Identifier: AGPL-3.0-only

export type PickerEntity =
  | "segment"
  | "campaign"
  | "list"
  | "coupon"
  | "template";

/**
 * Lightweight field metadata shared by the editor's initial graph and the
 * deferred picker implementation. Keeping it free of API imports prevents a
 * closed picker from pulling every pickable resource client into the route.
 */
export const PICKABLE_FIELDS: Readonly<Record<string, PickerEntity>> = {
  segment_id: "segment",
  campaign_id: "campaign",
  list_id: "list",
  coupon_pool_id: "coupon",
  template_id: "template",
};
