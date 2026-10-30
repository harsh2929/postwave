#!/usr/bin/env node
// Local SMS callback replay harness for first-customer pilot rehearsals.
//
// This never talks to Twilio/Telnyx/Bandwidth. It posts representative
// provider webhook payloads into Moosewave's public callback routes so local
// callback parsing, consent keyword handling, delivery updates, and failure
// handling can be tested before customer-owned provider credentials exist.

import crypto from "node:crypto";

const args = parseArgs(process.argv.slice(2));
const baseURL = trimRightSlash(args["base-url"] || process.env.POSTWAVE_BASE_URL || "http://localhost:3000");
const tenantID = args["tenant-id"] || process.env.POSTWAVE_TENANT_ID;
const provider = (args.provider || "twilio").toLowerCase();
const fixture = args.fixture || "stop";
const senderID = args["sender-id"] || process.env.POSTWAVE_SMS_SENDER_ID || "";
const dryRun = Boolean(args["dry-run"]);

if (!tenantID) {
  fail("Set --tenant-id or POSTWAVE_TENANT_ID.");
}

const req = buildRequest({ provider, fixture, tenantID, senderID });
if (dryRun) {
  console.log(JSON.stringify(req, null, 2));
  process.exit(0);
}

const res = await fetch(req.url, {
  method: "POST",
  headers: req.headers,
  body: req.body,
});
const text = await res.text();
console.log(`${res.status} ${res.statusText}`);
if (text) console.log(text);
if (!res.ok) process.exit(1);

function buildRequest({ provider, fixture, tenantID, senderID }) {
  switch (provider) {
    case "twilio":
      return twilioRequest(fixture, tenantID, senderID);
    case "telnyx":
      return jsonProviderRequest("telnyx", telnyxPayload(fixture, senderID), tenantID, senderID);
    case "bandwidth":
      return jsonProviderRequest("bandwidth", bandwidthPayload(fixture, senderID), tenantID, senderID);
    default:
      fail(`Unsupported provider ${provider}. Use twilio, telnyx, or bandwidth.`);
  }
}

function twilioRequest(fixture, tenantID, senderID) {
  const statusFixtures = {
    delivered: {
      MessageSid: "SM_REPLAY_DELIVERED",
      MessageStatus: "delivered",
      SmsStatus: "delivered",
      To: "+15551230000",
      From: "+15551239999",
    },
    failed: {
      MessageSid: "SM_REPLAY_FAILED",
      MessageStatus: "failed",
      SmsStatus: "failed",
      ErrorCode: "30007",
      ErrorMessage: "Carrier filtering simulated by replay harness",
      To: "+15551230000",
      From: "+15551239999",
    },
  };
  const inboundFixtures = {
    stop: { MessageSid: "SM_REPLAY_STOP", From: "+15551230000", To: "+15551239999", Body: "STOP" },
    start: { MessageSid: "SM_REPLAY_START", From: "+15551230000", To: "+15551239999", Body: "START" },
    help: { MessageSid: "SM_REPLAY_HELP", From: "+15551230000", To: "+15551239999", Body: "HELP" },
    reply: { MessageSid: "SM_REPLAY_REPLY", From: "+15551230000", To: "+15551239999", Body: "Tell me more" },
  };
  const isStatus = fixture in statusFixtures;
  const params = new URLSearchParams(isStatus ? statusFixtures[fixture] : inboundFixtures[fixture]);
  if (!params.size) fail(`Unknown Twilio fixture ${fixture}.`);

  const path = isStatus
    ? `/api/public/sms/twilio/${encodeURIComponent(tenantID)}/status`
    : `/api/public/sms/twilio/${encodeURIComponent(tenantID)}`;
  const url = withSender(`${baseURL}${path}`, senderID);
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  const token = process.env.TWILIO_WEBHOOK_AUTH_TOKEN || "";
  if (token) headers["X-Twilio-Signature"] = twilioSignature(token, url, params);
  return { url, headers, body: params.toString() };
}

function telnyxPayload(fixture, senderID) {
  const now = new Date().toISOString();
  if (fixture === "delivered" || fixture === "failed") {
    return {
      data: {
        event_type: fixture === "failed" ? "message.finalized" : "message.finalized",
        id: `evt-replay-${fixture}`,
        occurred_at: now,
        payload: {
          id: `msg-replay-${fixture}`,
          direction: "outbound",
          to: [{ phone_number: "+15551230000" }],
          from: { phone_number: "+15551239999" },
          completed_at: now,
          errors: fixture === "failed" ? [{ code: "40010", title: "Simulated carrier filtering" }] : [],
          tags: senderID ? [`sender_profile_id:${senderID}`] : [],
        },
      },
    };
  }
  return {
    data: {
      event_type: "message.received",
      id: `evt-replay-${fixture}`,
      occurred_at: now,
      payload: {
        id: `msg-replay-${fixture}`,
        direction: "inbound",
        from: { phone_number: "+15551230000" },
        to: [{ phone_number: "+15551239999" }],
        text: fixtureText(fixture),
        tags: senderID ? [`sender_profile_id:${senderID}`] : [],
      },
    },
  };
}

function bandwidthPayload(fixture, senderID) {
  const isStatus = fixture === "delivered" || fixture === "failed";
  return [
    {
      type: isStatus ? "message-delivered" : "message-received",
      time: new Date().toISOString(),
      message: {
        id: `bw-replay-${fixture}`,
        direction: isStatus ? "out" : "in",
        from: "+15551230000",
        to: ["+15551239999"],
        text: isStatus ? "" : fixtureText(fixture),
        applicationId: senderID || "postwave-replay",
      },
      description: fixture === "failed" ? "Simulated carrier filtering" : undefined,
      errorCode: fixture === "failed" ? "4702" : undefined,
    },
  ];
}

function jsonProviderRequest(provider, payload, tenantID, senderID) {
  const path = isStatusFixture(fixture)
    ? `/api/public/sms/${provider}/${encodeURIComponent(tenantID)}/status`
    : `/api/public/sms/${provider}/${encodeURIComponent(tenantID)}`;
  return {
    url: withSender(`${baseURL}${path}`, senderID),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}

function fixtureText(name) {
  switch (name) {
    case "stop":
      return "STOP";
    case "start":
      return "START";
    case "help":
      return "HELP";
    case "reply":
      return "Tell me more";
    default:
      fail(`Unknown fixture ${name}. Use stop, start, help, reply, delivered, or failed.`);
  }
}

function isStatusFixture(name) {
  return name === "delivered" || name === "failed";
}

function withSender(url, senderID) {
  if (!senderID) return url;
  const u = new URL(url);
  u.searchParams.set("sender_profile_id", senderID);
  return u.toString();
}

function twilioSignature(token, url, params) {
  const sorted = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  const payload = url + sorted.map(([k, v]) => `${k}${v}`).join("");
  return crypto.createHmac("sha1", token).update(payload).digest("base64");
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function trimRightSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function fail(message) {
  console.error(message);
  process.exit(2);
}
