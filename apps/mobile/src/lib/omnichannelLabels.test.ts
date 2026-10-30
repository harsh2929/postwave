import { describe, expect, it } from "vitest";

import { channelLabel, channelSpanSpeech } from "./omnichannelLabels";

describe("channelLabel", () => {
  it("uses the product spelling for every catalog channel", () => {
    expect(channelLabel("email")).toBe("Email");
    expect(channelLabel("sms")).toBe("SMS");
    expect(channelLabel("whatsapp")).toBe("WhatsApp");
    expect(channelLabel("rcs")).toBe("RCS");
    expect(channelLabel("push")).toBe("Push");
  });

  it("shows an unknown key VERBATIM rather than hiding it behind 'Other'", () => {
    // A definition naming a channel this build has not heard of is either a
    // typo or a newer server; both are things the reader needs to see.
    expect(channelLabel("fax")).toBe("fax");
    expect(channelLabel(" telegram ")).toBe("telegram");
  });
});

describe("channelSpanSpeech", () => {
  it("never says '0 channels:' — the empty case is its own sentence", () => {
    expect(channelSpanSpeech([])).toBe("No channel paths");
  });

  it("reads naturally at one and two channels", () => {
    expect(channelSpanSpeech(["email"])).toBe("Email only");
    expect(channelSpanSpeech(["email", "sms"])).toBe("Email and SMS");
  });

  it("counts before listing once the list stops being a sentence", () => {
    expect(channelSpanSpeech(["email", "sms", "whatsapp"])).toBe(
      "3 channels: Email, SMS, WhatsApp",
    );
  });
});
