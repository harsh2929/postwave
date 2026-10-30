/**
 * Tiny Express app that receives + verifies a Moosewave webhook.
 *
 * Run:  POSTWAVE_WEBHOOK_SECRET=owhsec_... tsx examples/verify-webhook.ts
 */
import express from "express";
import { verifySignature } from "@postwave/sdk";

const app = express();
const secret = process.env.POSTWAVE_WEBHOOK_SECRET!;
if (!secret) throw new Error("set POSTWAVE_WEBHOOK_SECRET");

// IMPORTANT: use the raw body so the signature can be verified bytewise.
app.post(
  "/postwave-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const ok = await verifySignature(
      req.body as Buffer,
      req.header("x-postwave-signature"),
      secret,
    );
    if (!ok) {
      res.status(401).json({ error: "bad signature" });
      return;
    }
    const envelope = JSON.parse((req.body as Buffer).toString("utf8"));
    console.log(
      `verified ${envelope.event.id} (${envelope.event.type}) ` +
        `via delivery ${envelope.delivery.id}`,
    );
    res.status(200).json({ ok: true });
  },
);

app.listen(4000, () => console.log("webhook receiver on :4000"));
