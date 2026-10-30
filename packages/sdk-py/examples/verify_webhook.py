"""Tiny FastAPI app that receives + verifies a Moosewave webhook.

Run::
    POSTWAVE_WEBHOOK_SECRET=owhsec_... uvicorn examples.verify_webhook:app --port 4000
"""

from __future__ import annotations

import json
import os

from fastapi import FastAPI, Header, HTTPException, Request

from postwave import verify_signature

app = FastAPI()
SECRET = os.environ.get("POSTWAVE_WEBHOOK_SECRET", "")


@app.post("/postwave-webhook")
async def webhook(req: Request, x_postwave_signature: str | None = Header(default=None)) -> dict:
    raw = await req.body()
    if not verify_signature(raw, x_postwave_signature, SECRET):
        raise HTTPException(401, "bad signature")
    envelope = json.loads(raw.decode("utf-8"))
    print(
        f"verified {envelope['event']['id']} ({envelope['event']['type']}) "
        f"via delivery {envelope['delivery']['id']}"
    )
    return {"ok": True}
