/**
 * PARITY (commerce-data) — the custom-object records browser.
 *
 * What a "does it render" assertion would never catch, and what these tests
 * are actually for:
 *
 *   verbatim   — the type is the WORKSPACE's. Keys, values, the type's own
 *                key/status/version and the record's natural id must reach the
 *                screen exactly as the server spelled them. A build that
 *                title-cased `court_ref` would rename someone's data.
 *   never blank— a record whose `properties` is not a field map, and a record
 *                whose map is empty, both still appear WITH a sentence saying
 *                what is missing. Skipping either hides a real record from
 *                someone looking it up on the road.
 *   never lie  — a value too long to print is described ("N nested fields"),
 *                never truncated into something that looks complete; and the
 *                page summary never claims one page is the whole type.
 *   read-only  — type definitions are admin and stay on the web admin. No
 *                create/edit/delete control may appear here.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import CustomObjectsRoute from "../app/(tabs)/custom-objects";
import { CustomObjectsScreen } from "../src/components/customobjects/CustomObjectsScreen";
import {
  parseCustomObjectRecords,
  parseCustomObjectTypes,
} from "../src/lib/customObjectRecords";

const mockState = {
  types: [] as unknown,
  typesError: false as boolean,
  records: undefined as unknown,
  recordsError: null as unknown,
};

jest.mock("@/hooks/useCustomObjects", () => ({
  useCustomObjectTypes: () => ({
    data: mockState.types,
    error: null,
    isError: mockState.typesError,
    isLoading: false,
    isSuccess: !mockState.typesError,
    refetch: jest.fn(),
  }),
  useCustomObjectRecords: () => ({
    data: mockState.records,
    error: mockState.recordsError,
    isError: mockState.recordsError !== null,
    isLoading: false,
    isSuccess: mockState.recordsError === null,
    refetch: jest.fn(),
  }),
}));

/** Exactly what `GET /api/v1/custom-objects/types` answers. */
const TYPES_PAYLOAD = {
  items: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      key: "court_booking",
      label: "Court booking",
      primaryKey: "court_ref",
      status: "active",
      version: 4,
    },
  ],
};

/** Exactly what `GET /custom-objects/types/{id}/records` answers. */
const RECORDS_PAYLOAD = {
  items: [
    {
      id: "aaaaaaaa-1111-4111-8111-111111111111",
      externalId: "BK-1001",
      updatedAt: "2026-09-01T10:00:00Z",
      properties: {
        court_ref: "Court 4 · Tue 18:00",
        paid: true,
        cancelled_at: null,
        itinerary: { note: "y".repeat(200) },
      },
    },
    {
      id: "bbbbbbbb-2222-4222-8222-222222222222",
      externalId: "BK-1002",
      properties: ["not", "a", "map"],
    },
    {
      id: "cccccccc-3333-4333-8333-333333333333",
      externalId: "BK-1003",
      properties: {},
    },
  ],
  limit: 25,
  hasMore: true,
};

afterEach(() => {
  mockState.types = [];
  mockState.typesError = false;
  mockState.records = undefined;
  mockState.recordsError = null;
});

async function renderScreen() {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <CustomObjectsScreen />
    </SafeAreaProvider>,
  );
}

describe("CustomObjectsScreen", () => {

  it("the registered route module renders the screen", async () => {
    // routeTestCoverage requires every app/ route module to be LOADED by a
    // native test: a screen-only test leaves the route file itself unproven,
    // which is exactly where a bad default export or a missing provider hides.
    await render(<SafeAreaProvider><CustomObjectsRoute /></SafeAreaProvider>);
    expect(typeof CustomObjectsRoute).toBe("function");
  });
  it("renders the workspace's own type vocabulary and record fields verbatim", async () => {
    mockState.types = parseCustomObjectTypes(TYPES_PAYLOAD);
    mockState.records = parseCustomObjectRecords(RECORDS_PAYLOAD);
    await renderScreen();

    // The type, in the workspace's words — not a client-side enum. Twice on
    // purpose: the picker option and the summary card under it.
    expect(screen.getAllByText("Court booking")).toHaveLength(2);
    expect(
      screen.getByText(
        /key court_booking · identified by court_ref · status active · definition v4/,
      ),
    ).toBeTruthy();

    // The record is titled by the property the TYPE calls the natural id —
    // and that property is still listed below, so the value appears twice.
    expect(screen.getAllByText("Court 4 · Tue 18:00")).toHaveLength(2);
    // Field keys keep the workspace's spelling, values keep the server's.
    expect(screen.getByText("court_ref")).toBeTruthy();
    expect(screen.getByText("paid")).toBeTruthy();
    expect(screen.getByText("true")).toBeTruthy();
    // A null field stays present rather than vanishing.
    expect(screen.getByText("cancelled_at")).toBeTruthy();
  });

  it("describes a value it cannot print instead of truncating it", async () => {
    mockState.types = parseCustomObjectTypes(TYPES_PAYLOAD);
    mockState.records = parseCustomObjectRecords(RECORDS_PAYLOAD);
    await renderScreen();

    expect(screen.getByText(/1 nested fields/)).toBeTruthy();
    // The 200-character value must not be on screen in any partial form.
    expect(screen.queryByText(/yyyyyyyyyy/)).toBeNull();
  });

  it("still shows a record whose properties are not a field map", async () => {
    mockState.types = parseCustomObjectTypes(TYPES_PAYLOAD);
    mockState.records = parseCustomObjectRecords(RECORDS_PAYLOAD);
    await renderScreen();

    expect(screen.getByText("BK-1002")).toBeTruthy();
    expect(
      screen.getByText(/properties arrived as a list, not a field map/),
    ).toBeTruthy();
    // And the one whose map is genuinely empty says THAT instead.
    expect(screen.getByText("BK-1003")).toBeTruthy();
    expect(screen.getByText(/property map is empty/)).toBeTruthy();
  });

  it("states the page it read and never calls it the whole type", async () => {
    mockState.types = parseCustomObjectTypes(TYPES_PAYLOAD);
    mockState.records = parseCustomObjectRecords(RECORDS_PAYLOAD);
    await renderScreen();

    expect(screen.getByText(/The 3 most recent records/)).toBeTruthy();
    expect(screen.queryByText(/that is all of them/)).toBeNull();
  });

  it("offers no way to change a definition — those are admin and stay on the web", async () => {
    mockState.types = parseCustomObjectTypes(TYPES_PAYLOAD);
    mockState.records = parseCustomObjectRecords(RECORDS_PAYLOAD);
    await renderScreen();

    for (const verb of [/^New type/, /^Edit/, /^Delete/, /^Add record/]) {
      expect(screen.queryByText(verb)).toBeNull();
    }
  });

  it("expands to every field rather than capping the list", async () => {
    mockState.types = parseCustomObjectTypes(TYPES_PAYLOAD);
    mockState.records = parseCustomObjectRecords({
      items: [
        {
          id: "dddddddd-4444-4444-8444-444444444444",
          externalId: "BK-1004",
          properties: Object.fromEntries(
            Array.from({ length: 9 }, (_, i) => [`field_${i}`, `value ${i}`]),
          ),
        },
      ],
      limit: 25,
      hasMore: false,
    });
    await renderScreen();

    expect(screen.queryByText("field_8")).toBeNull();
    // The control names the REAL total, so the collapse is a disclosure and
    // not a cap that hides how much was withheld.
    const toggle = screen.getByText("Show all 9 fields");
    await fireEvent.press(toggle);
    expect(screen.getByText("field_8")).toBeTruthy();
    expect(screen.getByText("value 8")).toBeTruthy();
  });

  it("says the workspace has none, without implying it failed", async () => {
    mockState.types = [];
    await renderScreen();
    expect(screen.getByText(/No object types defined/)).toBeTruthy();
    expect(screen.getByText(/created on the web admin/)).toBeTruthy();
  });
});
