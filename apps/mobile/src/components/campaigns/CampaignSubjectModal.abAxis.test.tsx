/**
 * The sheet-level wiring of the two parity rows (P2.7 / P2.8), which nothing
 * below the sheet can pin:
 *
 *   - "Test all" hands the hand-off hook the PARSED from-name axis from the
 *     field the person typed into. Drop that one prop and every unit still
 *     passes: the field parses, the lib caps, the hook posts — and the
 *     multivariate test silently becomes a subject-only one.
 *   - the Subject Lab link is given THIS campaign's id and current subject,
 *     and closes the sheet on navigate.
 *   - both rows live under the ≥10-character gate with the suggestion strip,
 *     and the axis is cleared when the sheet re-opens.
 *
 * The heavy leaves are stubbed to host elements that keep their props, so the
 * rows can be driven and read without rendering a native tree in node. The
 * sheet's OTHER two suites — the brand-voice one and the draft-checkpoint one
 * — could not keep that harness: both reach store/auth → expo-secure-store,
 * which throws `__DEV__ is not defined` under node vitest, so they live under
 * jest as __tests__/campaign-subject-voice.native.test.tsx and
 * __tests__/campaign-subject-checkpoint.native.test.tsx. This file stays here
 * only because it mocks `useCampaignIdentitySave` below — that hook is the
 * edge that reaches expo, and the rows under test here do not need it.
 */
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const hoisted = vi.hoisted(() => ({
  run: vi.fn(),
  onClose: vi.fn(),
}));

vi.mock("react-native", () => ({ Text: "Text", View: "View" }));

vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@/components/KeyboardFormSheet", () => ({
  KeyboardFormSheet: ({
    visible,
    children,
  }: {
    visible: boolean;
    children?: React.ReactNode;
  }) => (visible ? <>{children}</> : null),
}));

type Props = Record<string, unknown>;
const stub = (name: string) =>
  name as unknown as React.ComponentType<Props>;
const FieldInputStub = stub("FieldInput");
const AbFromNamesStub = stub("AbFromNames");
const SubjectLabLinkStub = stub("SubjectLabLink");
const SuggestionsStub = stub("Suggestions");

vi.mock("@/components/campaigns/CampaignFieldInput", () => ({
  CampaignFieldInput: (props: Props) => <FieldInputStub {...props} />,
}));
vi.mock("@/components/campaigns/CampaignAbFromNamesField", () => ({
  CampaignAbFromNamesField: (props: Props) => <AbFromNamesStub {...props} />,
}));
vi.mock("@/components/campaigns/CampaignSubjectLabLink", () => ({
  CampaignSubjectLabLink: (props: Props) => <SubjectLabLinkStub {...props} />,
}));
vi.mock("@/components/SubjectLineSuggestions", () => ({
  SubjectLineSuggestions: (props: Props) => <SuggestionsStub {...props} />,
}));
vi.mock("@/components/campaigns/CampaignIdentityFields", () => ({
  CampaignIdentityFields: () => null,
}));
vi.mock("@/components/SegmentedControl", () => ({
  SegmentedControl: () => null,
}));
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/campaigns/CampaignDetailControls", () => ({
  ActionButton: () => null,
  ModalHeader: () => null,
}));
vi.mock("@/hooks/useCampaignAbHandoff", () => ({
  useCampaignAbHandoff: () => ({
    pending: false,
    run: hoisted.run,
    blockedReason: null,
  }),
}));
vi.mock("@/hooks/useCampaignIdentitySave", () => ({
  useCampaignIdentitySave: () => ({ save: vi.fn(), pending: false }),
}));
vi.mock("@/lib/haptics", () => ({
  haptics: { error: vi.fn(), warning: vi.fn(), tap: vi.fn() },
}));
vi.mock("@/lib/theme", () => ({
  useTheme: () => ({
    t: { fg: "#fff", fgMuted: "#aaa", fgSubtle: "#888", warning: "#fa0" },
  }),
}));
vi.mock("@/lib/fonts", () => ({
  FONT: { regular: "Inter", semibold: "Inter", bold: "Inter" },
}));

const { CampaignSubjectModal } = await import("./CampaignSubjectModal");

const CAMPAIGN = {
  id: "cmp_1",
  name: "August newsletter",
  status: "draft",
  subject: "Saved subject line",
  preview_text: "Saved preview",
  from_name: "Ada",
  reply_to: "ada@example.com",
  created_at: "2026-08-01T10:00:00Z",
  updated_at: "2026-08-04T10:00:00Z",
} as Parameters<typeof CampaignSubjectModal>[0]["campaign"];

let renderer: TestRenderer.ReactTestRenderer | undefined;

function isHost(node: TestRenderer.ReactTestInstance, name: string): boolean {
  return (node.type as unknown) === name;
}

function render(visible: boolean) {
  const element = (
    <CampaignSubjectModal
      visible={visible}
      onClose={hoisted.onClose}
      campaign={CAMPAIGN}
    />
  );
  act(() => {
    if (renderer) renderer.update(element);
    else renderer = TestRenderer.create(element);
  });
}

function host(name: string): TestRenderer.ReactTestInstance {
  return renderer!.root.find((node) => isHost(node, name));
}

function hosts(name: string): TestRenderer.ReactTestInstance[] {
  return renderer!.root.findAll((node) => isHost(node, name));
}

function typeSubject(value: string) {
  const field = renderer!.root.find(
    (node) => isHost(node, "FieldInput") && node.props.label === "Subject line",
  );
  act(() => {
    (field.props.onChangeText as (next: string) => void)(value);
  });
}

beforeEach(() => {
  renderer = undefined;
  hoisted.run.mockClear();
  hoisted.onClose.mockClear();
});

describe("the from-name axis reaches the hand-off (P2.7)", () => {
  it("passes the PARSED from-names alongside the variants and split", () => {
    render(true);
    act(() => {
      (host("AbFromNames").props.onChangeText as (next: string) => void)(
        " Acme Team \n\nJane at Acme\n",
      );
    });
    act(() => {
      (host("Suggestions").props.onVariantsChange as (n: number) => void)(3);
    });
    act(() => {
      (host("Suggestions").props.onTestAll as (v: string[]) => void)([
        "S1",
        "S2",
        "S3",
      ]);
    });
    // "even" split omits split_percentage (null) so the server computes 100/N.
    expect(hoisted.run).toHaveBeenCalledWith(["S1", "S2", "S3"], null, {
      fromNameVariants: ["Acme Team", "Jane at Acme"],
    });
  });

  it("tells the field how many subjects it will be crossed with", () => {
    render(true);
    expect(host("AbFromNames").props.subjectCount).toBe(2);
    act(() => {
      (host("Suggestions").props.onVariantsChange as (n: number) => void)(4);
    });
    expect(host("AbFromNames").props.subjectCount).toBe(4);
  });

  it("clears the axis when the sheet re-opens", () => {
    render(true);
    act(() => {
      (host("AbFromNames").props.onChangeText as (next: string) => void)(
        "Acme Team\nJane at Acme",
      );
    });
    expect(host("AbFromNames").props.value).toBe("Acme Team\nJane at Acme");
    render(false);
    render(true);
    expect(host("AbFromNames").props.value).toBe("");
  });
});

describe("the Subject Lab seed link (P2.8)", () => {
  it("names THIS campaign and its current subject, and closes the sheet", () => {
    render(true);
    typeSubject("A subject being edited right now");
    const link = host("SubjectLabLink");
    expect(link.props.campaignId).toBe("cmp_1");
    expect(link.props.subject).toBe("A subject being edited right now");
    (link.props.onNavigate as () => void)();
    expect(hoisted.onClose).toHaveBeenCalledTimes(1);
  });

  it("is withheld, with the axis, below the suggestion strip's 10-char floor", () => {
    render(true);
    typeSubject("short");
    expect(hosts("SubjectLabLink")).toHaveLength(0);
    expect(hosts("AbFromNames")).toHaveLength(0);
    expect(hosts("Suggestions")).toHaveLength(0);
  });
});
