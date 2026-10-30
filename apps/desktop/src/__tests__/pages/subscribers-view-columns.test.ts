import { describe, expect, it } from "vitest";

import {
  SUBSCRIBER_COLUMN_CATALOG,
  subscriberColumnDefinition,
  subscriberGridTemplate,
  visibleSubscriberColumns,
} from "../../pages/subscribers-view-columns";

describe("subscriber view columns", () => {
  it("keeps the default catalog order and required email column", () => {
    expect(visibleSubscriberColumns({})).toEqual([
      "avatar",
      "email",
      "status",
      "joined",
      "engagement",
      "tags",
    ]);
    expect(
      SUBSCRIBER_COLUMN_CATALOG.find((column) => column.key === "email"),
    ).toMatchObject({ required: true, width: "1.5fr" });
    expect(subscriberColumnDefinition("email")).toMatchObject({
      label: "Email",
      width: "1.5fr",
    });
    expect(subscriberColumnDefinition("toString")).toBeUndefined();
  });

  it("drops unknown persisted keys and restores email exactly once", () => {
    expect(
      visibleSubscriberColumns({
        columns: [
          "tags",
          "tags",
          "retired_column",
          "__proto__",
          "toString",
          "status",
        ],
      }),
    ).toEqual(["email", "tags", "status"]);
    expect(
      visibleSubscriberColumns({
        columns: ["status", "email", "email", "tags", "status"],
      }),
    ).toEqual(["status", "email", "tags"]);
  });

  it("builds the exact selection, data-column, and action grid", () => {
    expect(subscriberGridTemplate(["email", "rating", "unknown"])).toBe(
      "32px 1.5fr 90px 1fr 64px",
    );
  });
});
