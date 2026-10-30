// SPDX-License-Identifier: MIT
//
// `postwave generate` — code scaffolders for common Moosewave integrations.
//
// Subcommands:
//   postwave generate webhook-handler --framework express|hono|next-route
//   postwave generate email --name <Name>
//
// Templates are emitted to stdout (or to --out <path> when supplied) so
// they can be piped straight into a file or reviewed in-place.

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import chalk from "chalk";

export type WebhookFramework = "express" | "hono" | "next-route";

export interface GenerateWebhookOpts {
  framework?: WebhookFramework;
  out?: string;
  force?: boolean;
}

export interface GenerateEmailOpts {
  name?: string;
  out?: string;
  force?: boolean;
}

const WEBHOOK_DISPATCH_HELPERS = `type PostwaveWebhookEvent = {
  id: string;
  type:
    | "campaign.sent"
    | "subscriber.added"
    | "subscriber.removed"
    | "subscriber.unsubscribed"
    | "approval.requested"
    | "approval.decided"
    | "audit.created"
    | "bounce.received"
    | "list.subscriber.added";
  occurred_at: string;
  data: Record<string, unknown>;
};

type PostwaveWebhookEnvelope = {
  event: PostwaveWebhookEvent;
  webhook: { id: string };
  delivery: { id: string; attempt: number };
};

async function handlePostwaveEvent(event: PostwaveWebhookEvent): Promise<void> {
  switch (event.type) {
    case "campaign.sent":
    case "bounce.received":
      await handleCampaignEvent(event);
      return;
    case "subscriber.added":
    case "subscriber.removed":
    case "subscriber.unsubscribed":
      await handleSubscriberEvent(event);
      return;
    case "list.subscriber.added":
      await handleListMembershipEvent(event);
      return;
    case "approval.requested":
    case "approval.decided":
    case "audit.created":
      await handleOperationalEvent(event);
      return;
    default:
      await handleUnknownPostwaveEvent(event);
  }
}

async function handleCampaignEvent(event: PostwaveWebhookEvent): Promise<void> {
  console.log("postwave campaign event", event.type, event.data);
}

async function handleSubscriberEvent(event: PostwaveWebhookEvent): Promise<void> {
  console.log("postwave subscriber event", event.type, event.data);
}

async function handleListMembershipEvent(event: PostwaveWebhookEvent): Promise<void> {
  console.log("postwave list-membership event", event.type, event.data);
}

async function handleOperationalEvent(event: PostwaveWebhookEvent): Promise<void> {
  console.log("postwave operational event", event.type, event.data);
}

async function handleUnknownPostwaveEvent(event: PostwaveWebhookEvent): Promise<void> {
  console.warn("unhandled postwave event", event.type, event.id);
}
`;

const EXPRESS_TEMPLATE = `// Moosewave webhook handler — Express + raw body.
// Verifies the X-Postwave-Signature header before parsing the JSON body.

import type { Request, Response, NextFunction } from "express";
import express from "express";
import { verifySignature } from "@postwave/sdk/webhook";

const SECRET = process.env.POSTWAVE_WEBHOOK_SECRET ?? "";
const MAX_WEBHOOK_BODY_BYTES = "256kb";

const app = express();

// IMPORTANT: capture the raw body bytes — JSON.stringify is NOT
// round-trippable, so we cannot re-serialize a parsed body for HMAC.
app.post(
  "/webhooks/postwave",
  express.raw({ type: "application/json", limit: MAX_WEBHOOK_BODY_BYTES }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const raw = (req.body as Buffer).toString("utf8");
      const sig = req.header("x-postwave-signature");
      const ok = await verifySignature(raw, sig, SECRET);
      if (!ok) return res.status(401).json({ error: "invalid signature" });

      const envelope = JSON.parse(raw) as PostwaveWebhookEnvelope;
      // Use envelope.event.id as a durable unique key before side effects.
      await handlePostwaveEvent(envelope.event);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

${WEBHOOK_DISPATCH_HELPERS}
`;

const HONO_TEMPLATE = `// Moosewave webhook handler — Hono.
// Verifies the X-Postwave-Signature header before parsing the JSON body.

import { Hono } from "hono";
import { verifySignature } from "@postwave/sdk/webhook";

const SECRET = process.env.POSTWAVE_WEBHOOK_SECRET ?? "";
const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

export const app = new Hono();

app.post("/webhooks/postwave", async (c) => {
  let raw: string;
  try {
    raw = await readRequestTextLimited(c.req.raw); // raw bytes — do not re-stringify
  } catch {
    return c.json({ error: "webhook body too large" }, 413);
  }
  const sig = c.req.header("x-postwave-signature");
  const ok = await verifySignature(raw, sig, SECRET);
  if (!ok) return c.json({ error: "invalid signature" }, 401);

  const envelope = JSON.parse(raw) as PostwaveWebhookEnvelope;
  // Use envelope.event.id as a durable unique key before side effects.
  await handlePostwaveEvent(envelope.event);
  return c.body(null, 204);
});

async function readRequestTextLimited(req: Request): Promise<string> {
  const declared = req.headers.get("content-length");
  if (declared && Number(declared) > MAX_WEBHOOK_BODY_BYTES) {
    throw new Error("webhook body too large");
  }
  const reader = req.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_WEBHOOK_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("webhook body too large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

${WEBHOOK_DISPATCH_HELPERS}
`;

const NEXT_ROUTE_TEMPLATE = `// Moosewave webhook handler — Next.js App Router (route handler).
// File: app/api/webhooks/postwave/route.ts
// Verifies the X-Postwave-Signature header before parsing the JSON body.

import { NextResponse } from "next/server";
import { verifySignature } from "@postwave/sdk/webhook";

export const runtime = "nodejs"; // edge also works with the Web Crypto path

const SECRET = process.env.POSTWAVE_WEBHOOK_SECRET ?? "";
const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

export async function POST(req: Request): Promise<Response> {
  let raw: string;
  try {
    raw = await readRequestTextLimited(req); // raw bytes — do not re-stringify
  } catch {
    return NextResponse.json({ error: "webhook body too large" }, { status: 413 });
  }
  const sig = req.headers.get("x-postwave-signature");
  const ok = await verifySignature(raw, sig, SECRET);
  if (!ok) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  const envelope = JSON.parse(raw) as PostwaveWebhookEnvelope;
  // Use envelope.event.id as a durable unique key before side effects.
  await handlePostwaveEvent(envelope.event);
  return new NextResponse(null, { status: 204 });
}

async function readRequestTextLimited(req: Request): Promise<string> {
  const declared = req.headers.get("content-length");
  if (declared && Number(declared) > MAX_WEBHOOK_BODY_BYTES) {
    throw new Error("webhook body too large");
  }
  const reader = req.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_WEBHOOK_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("webhook body too large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

${WEBHOOK_DISPATCH_HELPERS}
`;

function pickWebhookTemplate(framework: WebhookFramework): string {
  switch (framework) {
    case "express":
      return EXPRESS_TEMPLATE;
    case "hono":
      return HONO_TEMPLATE;
    case "next-route":
      return NEXT_ROUTE_TEMPLATE;
  }
}

function emit(
  content: string,
  out: string | undefined,
  defaultName: string,
  force = false,
): void {
  if (!out) {
    process.stdout.write(content);
    return;
  }
  const target = resolve(process.cwd(), out);
  if (existsSync(target) && !force) {
    console.error(chalk.red(`Refusing to overwrite ${target}. Pass --force to replace it.`));
    process.exitCode = 1;
    return;
  }
  const dir = dirname(target);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(target, content, "utf8");
  console.log(chalk.green(`wrote ${target} (${defaultName})`));
}

export function generateWebhookHandler(opts: GenerateWebhookOpts): void {
  const framework = opts.framework;
  if (!framework || !["express", "hono", "next-route"].includes(framework)) {
    console.error(
      chalk.red(
        "generate webhook-handler: --framework must be one of 'express', 'hono', 'next-route'",
      ),
    );
    process.exitCode = 1;
    return;
  }
  const tmpl = pickWebhookTemplate(framework);
  emit(tmpl, opts.out, `webhook-handler.${framework}.ts`, opts.force === true);
}

function emailComponentTemplate(name: string): string {
  return `// SPDX-License-Identifier: MIT
import * as React from "react";
import {
  Email,
  Section,
  Column,
  Heading,
  Text,
  Button,
  Spacer,
  Footer,
} from "@postwave/email-react";

export default function ${name}(): React.ReactElement {
  return (
    <Email preview="A short preview line here.">
      <Section>
        <Column>
          <Heading level={1} align="center">
            Welcome
          </Heading>
          <Text>
            Replace this body with your own copy. Use {"<Text>"} for paragraphs,
            {" <Heading>"} for headings, and {"<Button>"} for calls to action.
          </Text>
          <Spacer height="16px" />
          <Button href="https://example.test/cta" align="center">
            Get started
          </Button>
        </Column>
      </Section>
      <Footer
        senderName="Your Brand"
        address="1 Some Street, City, Country"
        unsubscribeUrl="{{unsubscribe_url}}"
      />
    </Email>
  );
}
`;
}

export function generateEmail(opts: GenerateEmailOpts): void {
  const name = opts.name?.trim();
  if (!name || !/^[A-Z][A-Za-z0-9]*$/.test(name)) {
    console.error(
      chalk.red(
        "generate email: --name must be a PascalCase identifier (e.g. Welcome, ProductLaunch)",
      ),
    );
    process.exitCode = 1;
    return;
  }
  const content = emailComponentTemplate(name);
  const out = opts.out ?? `${name}.tsx`;
  emit(content, out, `${name}.tsx`, opts.force === true);
}
