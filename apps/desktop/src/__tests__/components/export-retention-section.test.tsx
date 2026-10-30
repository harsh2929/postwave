import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ExportRetentionSection,
  clampExportRetentionDays,
  clampStoredExportCount,
  formatExportStorageBytes,
} from "../../components/settings/ExportRetentionSection";

describe("export retention settings extraction", () => {
  it("clamps retention and stored-export controls at the server contract", () => {
    expect(clampExportRetentionDays(1)).toBe(7);
    expect(clampExportRetentionDays(30.6)).toBe(31);
    expect(clampExportRetentionDays(3000)).toBe(2555);
    expect(clampExportRetentionDays(Number.NaN)).toBe(7);
    expect(clampStoredExportCount(0)).toBe(1);
    expect(clampStoredExportCount(20.6)).toBe(21);
    expect(clampStoredExportCount(900)).toBe(500);
    expect(clampStoredExportCount(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it("formats byte totals without losing the reviewed units", () => {
    expect(formatExportStorageBytes(512)).toBe("512 B");
    expect(formatExportStorageBytes(1536)).toBe("1.5 KB");
    expect(formatExportStorageBytes(2 * 1024 * 1024)).toBe("2.0 MB");
    expect(formatExportStorageBytes(3 * 1024 * 1024 * 1024)).toBe("3.00 GB");
    expect(formatExportStorageBytes(-1)).toBe("0 B");
  });

  it("renders admin-gated controls with accessible names", () => {
    const html = renderToStaticMarkup(
      <ExportRetentionSection canAdmin={false} />,
    );
    expect(html).toContain("Export retention");
    expect(html).toContain('aria-label="Retention days"');
    expect(html).toContain('aria-label="Export retention days"');
    expect(html).toContain('aria-label="Maximum concurrent exports"');
    expect(html).toContain("Admin role required");
    expect(html).toContain('disabled=""');
  });
});
