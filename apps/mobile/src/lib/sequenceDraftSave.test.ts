import { describe, expect, it } from "vitest";

import type { SequenceDraftEmail } from "./sequenceDraft";
import {
  draftEmailsToWireSteps,
  draftSaveProblems,
} from "./sequenceDraftSave";

function email(over: Partial<SequenceDraftEmail> = {}): SequenceDraftEmail {
  return {
    id: "draft-email-1",
    subject: "Welcome",
    body: "Hello there.",
    delayHours: 0,
    ...over,
  };
}

describe("expanding a reviewed draft into save steps", () => {
  it("inserts a delay node ahead of every waiting email and renumbers", () => {
    const steps = draftEmailsToWireSteps([
      email({ id: "a", subject: "One", body: "1", delayHours: 0 }),
      email({ id: "b", subject: "Two", body: "2", delayHours: 48 }),
      email({ id: "c", subject: "Three", body: "3", delayHours: 5 }),
    ]);
    expect(steps).toEqual([
      { type: "email", position: 1, email: { subject: "One", body: "1" } },
      {
        type: "delay",
        position: 2,
        delay: { seconds: 172_800, value: 2, unit: "days" },
      },
      { type: "email", position: 3, email: { subject: "Two", body: "2" } },
      {
        type: "delay",
        position: 4,
        delay: { seconds: 18_000, value: 5, unit: "hours" },
      },
      { type: "email", position: 5, email: { subject: "Three", body: "3" } },
    ]);
  });

  it("emits no delay node for a missing wait", () => {
    const steps = draftEmailsToWireSteps([
      email({ delayHours: null, subject: "Only", body: "x" }),
    ]);
    expect(steps).toEqual([
      { type: "email", position: 1, email: { subject: "Only", body: "x" } },
    ]);
  });

  it("positions are dense and unique — validateSteps rejects anything else", () => {
    const steps = draftEmailsToWireSteps(
      Array.from({ length: 6 }, (_, i) =>
        email({ id: `e${i}`, delayHours: i === 0 ? 0 : 24 }),
      ),
    );
    expect(steps.map((s) => s.position)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
    expect(new Set(steps.map((s) => s.position)).size).toBe(steps.length);
  });
});

describe("save preconditions", () => {
  it("reports every bad card at once, not just the first", () => {
    const problems = draftSaveProblems({
      name: "",
      emails: [
        email({ id: "a", subject: "" }),
        email({ id: "b", body: "   " }),
      ],
    });
    expect(problems).toEqual([
      { id: "sequence", message: "Give the sequence a name." },
      { id: "a", message: "Add a subject line." },
      { id: "b", message: "Add an email body." },
    ]);
  });

  it("refuses a draft with nothing left in it", () => {
    expect(draftSaveProblems({ name: "Keep", emails: [] })).toEqual([
      { id: "sequence", message: "Keep at least one email, or discard the draft." },
    ]);
  });

  it("bounds the subject at the server's rune ceiling", () => {
    const problems = draftSaveProblems({
      name: "Fine",
      emails: [email({ subject: "s".repeat(256) })],
    });
    expect(problems).toEqual([
      {
        id: "draft-email-1",
        message: "Subject lines are limited to 255 characters.",
      },
    ]);
  });

  it("passes a clean draft", () => {
    expect(draftSaveProblems({ name: "Winback", emails: [email()] })).toEqual(
      [],
    );
  });
});
