import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({}));
vi.mock("@postwave/sdk", () => ({ PostwaveClient: class {} }));
vi.mock("@/api/client", () => ({ clearClient: vi.fn() }));
vi.mock("@/api/auth", () => ({ redactAuthError: (value: string) => value }));
vi.mock("@/components/settings/SettingsScreenPrimitives", () => ({}));
vi.mock("@/lib/fonts", () => ({ FONT: {} }));
vi.mock("@/lib/config", () => ({ validateApiBaseUrl: vi.fn() }));
vi.mock("@/lib/theme", () => ({ useTheme: vi.fn() }));
vi.mock("@/store/auth", () => ({ useAuthStore: vi.fn() }));
vi.mock("@/hooks/useDirtyGuard", () => ({ useDirtyGuard: vi.fn() }));
vi.mock("@/components/settings/ApiConnectionSummary", () => ({}));
vi.mock("@/components/Toast", () => ({ useToast: vi.fn() }));

// eslint-disable-next-line import/first
import { apiConnectionDirty, apiProbeIdentity } from "./ApiConnectionSection";

describe("apiProbeIdentity", () => {
  it("reads the backend /me user field", () => {
    expect(apiProbeIdentity({ user: "owner@example.com" })).toBe(
      "owner@example.com",
    );
  });

  it("keeps compatibility with an older email field", () => {
    expect(apiProbeIdentity({ email: "legacy@example.com" })).toBe(
      "legacy@example.com",
    );
  });
});

describe("apiConnectionDirty", () => {
  const stored = { baseUrl: null, apiKey: null, tenantId: null };

  it("treats an untouched form on a session-only install as clean", () => {
    // The trap: `null` stored and `""` typed are the same state. Comparing
    // them naively would arm the unsaved-changes guard on every visit.
    expect(
      apiConnectionDirty(
        { urlInput: "", keyInput: "", tenantInput: "" },
        stored,
      ),
    ).toBe(false);
  });

  it("is clean when every field still matches what is stored", () => {
    expect(
      apiConnectionDirty(
        { urlInput: "https://a", keyInput: "k", tenantInput: "t" },
        { baseUrl: "https://a", apiKey: "k", tenantId: "t" },
      ),
    ).toBe(false);
  });

  it("is dirty when any single field diverges", () => {
    const saved = { baseUrl: "https://a", apiKey: "k", tenantId: "t" };
    expect(
      apiConnectionDirty(
        { urlInput: "https://b", keyInput: "k", tenantInput: "t" },
        saved,
      ),
    ).toBe(true);
    expect(
      apiConnectionDirty(
        { urlInput: "https://a", keyInput: "k2", tenantInput: "t" },
        saved,
      ),
    ).toBe(true);
    expect(
      apiConnectionDirty(
        { urlInput: "https://a", keyInput: "k", tenantInput: "t2" },
        saved,
      ),
    ).toBe(true);
  });
});
