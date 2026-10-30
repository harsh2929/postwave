import { describe, expect, it } from "vitest";

import { migrationFileValidationError } from "../../components/migration/MigrationFileFieldInput";

describe("migration file validation", () => {
  const maxBytes = 200 * 1024 * 1024;

  it("accepts a non-empty CSV and rejects empty, oversized, or unrelated files", () => {
    expect(
      migrationFileValidationError(
        { name: "subscribers.csv", type: "text/csv", size: 128 },
        maxBytes,
      ),
    ).toBeNull();
    expect(
      migrationFileValidationError(
        { name: "subscribers.csv", type: "text/csv", size: 0 },
        maxBytes,
      ),
    ).toContain("empty");
    expect(
      migrationFileValidationError(
        {
          name: "subscribers.csv",
          type: "text/csv",
          size: maxBytes + 1,
        },
        maxBytes,
      ),
    ).toContain("200 MB or smaller");
    expect(
      migrationFileValidationError(
        { name: "contacts.json", type: "application/json", size: 128 },
        maxBytes,
      ),
    ).toContain("unsupported format");
  });

  it("accepts ZIP only for a source policy that explicitly allows it", () => {
    const zip = { name: "publication.zip", type: "application/zip", size: 128 };
    expect(migrationFileValidationError(zip, maxBytes)).toContain(
      "unsupported format",
    );
    expect(
      migrationFileValidationError(zip, maxBytes, ["zip", "csv"]),
    ).toBeNull();
  });
});
