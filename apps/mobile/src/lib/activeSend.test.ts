import { describe, expect, it } from "vitest";

import { activeSendView, pickActiveSend } from "./activeSend";

describe("pickActiveSend", () => {
  it("returns null when nothing is in flight", () => {
    expect(pickActiveSend(undefined)).toBeNull();
    expect(pickActiveSend([])).toBeNull();
    expect(
      pickActiveSend([
        { id: "a", status: "draft" },
        { id: "b", status: "sent" },
        { id: "c", status: "scheduled" },
      ]),
    ).toBeNull();
  });

  it("recognises every engine spelling of an in-flight send", () => {
    for (const status of ["sending", "running", "queued", "processing"]) {
      expect(pickActiveSend([{ id: "a", status }])?.campaign.id).toBe("a");
    }
  });

  it("pins the first live row and COUNTS the rest rather than hiding them", () => {
    const picked = pickActiveSend([
      { id: "a", status: "sent" },
      { id: "b", status: "sending" },
      { id: "c", status: "running" },
      { id: "d", status: "draft" },
      { id: "e", status: "queued" },
    ]);
    expect(picked?.campaign.id).toBe("b");
    // A strip that silently picked one of three would read as "one send is
    // running", which is a worse answer than no strip.
    expect(picked?.others).toBe(2);
  });
});

describe("activeSendView — the four progress shapes", () => {
  const base = { name: "Spring launch", others: 0 };

  it("says the read FAILED rather than showing a stalled send", () => {
    const view = activeSendView({ ...base, sent: 4, unavailable: true });
    expect(view.progress).toMatch(/couldn't be read/iu);
    // No bar: drawing one against numbers we could not read is a lie.
    expect(view.fraction).toBeNull();
  });

  it("distinguishes 'no report yet' from 'nothing sent'", () => {
    const view = activeSendView({ ...base, sent: null, audience: 1200 });
    expect(view.progress).toMatch(/waiting for the first delivery event/iu);
    expect(view.progress).not.toMatch(/\b0\b/u);
    expect(view.fraction).toBeNull();
  });

  it("states the numerator alone when there is no denominator", () => {
    const view = activeSendView({ ...base, sent: 4201, audience: null });
    expect(view.progress).toBe("4,201 messages sent so far");
    // No denominator, no bar — never a 0%-wide bar implying no progress.
    expect(view.fraction).toBeNull();
  });

  it("uses the singular form for exactly one message", () => {
    expect(activeSendView({ ...base, sent: 1 }).progress).toBe(
      "1 message sent so far",
    );
  });

  it("renders the full fraction when both numbers are known", () => {
    const view = activeSendView({ ...base, sent: 4201, audience: 12483 });
    expect(view.progress).toBe("4,201 of 12,483 sent");
    expect(view.fraction).toBeCloseTo(4201 / 12483, 6);
  });

  it("clamps a numerator that has overshot its audience", () => {
    // Re-sends and retries can push `sent` past the preview's count; a bar
    // wider than its track is a rendering bug.
    expect(activeSendView({ ...base, sent: 200, audience: 100 }).fraction).toBe(
      1,
    );
  });

  it("treats a zero audience as no denominator, not as a divide by zero", () => {
    const view = activeSendView({ ...base, sent: 5, audience: 0 });
    expect(view.fraction).toBeNull();
    expect(view.progress).toBe("5 messages sent so far");
  });
});

describe("activeSendView — titles, rates and the spoken sentence", () => {
  it("prefers the subject, falls back to the name, then states the gap", () => {
    expect(
      activeSendView({ subject: "50% off", name: "BF", sent: 0 }).title,
    ).toBe("50% off");
    expect(activeSendView({ subject: "   ", name: "BF", sent: 0 }).title).toBe(
      "BF",
    );
    expect(activeSendView({ sent: 0 }).title).toBe("Untitled campaign");
  });

  it("renders an em-dash for a rate the server did not report", () => {
    const view = activeSendView({ name: "x", openRate: 0.124, clickRate: null });
    expect(view.rates).toBe("12.4% opened · — clicked");
  });

  it("changes the SPOKEN FRAME when a rate is missing, not just the slot", () => {
    // Substituting "click rate not reported" into the `{click} clicked` slot
    // produced "click rate not reported clicked" — the verb belongs to the
    // frame, so the frame has to change with the fact. Asserted end to end
    // rather than with `toContain`, which passed the broken version.
    const base = { name: "Spring launch", sent: 1, others: 0 } as const;
    expect(
      activeSendView({ ...base, openRate: 0.124, clickRate: null }).spoken,
    ).toBe(
      "Spring launch is sending now. 1 message sent so far. " +
        "12.4% opened, click rate not reported. Open this campaign.",
    );
    expect(
      activeSendView({ ...base, openRate: null, clickRate: 0.03 }).spoken,
    ).toBe(
      "Spring launch is sending now. 1 message sent so far. " +
        "Open rate not reported, 3.0% clicked. Open this campaign.",
    );
    expect(
      activeSendView({ ...base, openRate: null, clickRate: null }).spoken,
    ).toBe(
      "Spring launch is sending now. 1 message sent so far. " +
        "Neither open nor click rate has been reported. Open this campaign.",
    );
  });

  it("keeps a genuine zero rate as 0%, never as an em-dash", () => {
    // Early in a send 0% opened is a real measurement, not a missing one.
    expect(activeSendView({ name: "x", openRate: 0, clickRate: 0 }).rates).toBe(
      "0.0% opened · 0.0% clicked",
    );
  });

  it("composes one whole spoken sentence, with the extra sends when there are any", () => {
    const alone = activeSendView({
      name: "Spring launch",
      sent: 10,
      audience: 100,
      openRate: 0.2,
      clickRate: 0.05,
    });
    expect(alone.others).toBeNull();
    expect(alone.spoken).toBe(
      "Spring launch is sending now. 10 of 100 sent. 20.0% opened, 5.0% clicked. Open this campaign.",
    );

    const crowded = activeSendView({
      name: "Spring launch",
      others: 2,
      sent: 10,
      audience: 100,
      openRate: 0.2,
      clickRate: 0.05,
    });
    expect(crowded.others).toBe("+2 more sending");
    expect(crowded.spoken).toContain("+2 more sending");
  });
});
