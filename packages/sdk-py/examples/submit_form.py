"""Submit a public Moosewave form (no auth required)."""

from __future__ import annotations

import os

from postwave import Moosewave


def main() -> None:
    pw = Moosewave(api_key="anon", base_url=os.environ.get("POSTWAVE_BASE", "https://api.moosewave.com"))
    slug = os.environ.get("FORM_SLUG", "newsletter")
    out = pw.request("POST", f"/api/public/forms/{slug}/submit", body={
        "email": "test@example.com",
        "name": "Test User",
        "consent": "yes",
        "customFields": {"source": "sdk-example"},
    })
    print(out)


if __name__ == "__main__":
    main()
