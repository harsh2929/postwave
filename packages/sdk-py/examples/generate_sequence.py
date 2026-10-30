"""Generate a 3-email welcome series in the tenant's voice."""

from __future__ import annotations

import os

from postwave import NotFoundError, Moosewave
from postwave.types import GenerateRequest, RegenerateRequest, StyleControls


def main() -> None:
    pw = Moosewave(api_key=os.environ["POSTWAVE_API_KEY"], tenant_id=os.environ.get("POSTWAVE_TENANT"))

    try:
        pw.voice_profile.get()
    except NotFoundError:
        print("No profile yet — building from registered sources...")
        pw.voice_profile.build()

    seq = pw.sequences.generate(GenerateRequest(
        template_id="tpl_welcome_3",
        name="Welcome series",
        variables={"product_name": "Acme", "founder_name": "Alex"},
        style_controls=StyleControls(humor=0.2, directness=0.5, length="as-is"),
    ))
    print(f"Generated {len(seq.emails)} emails (id={seq.id}):")
    for e in seq.emails:
        print(f"  #{e.position} fidelity={e.voice_fidelity_score:.1f} subject={e.subject!r}")

    better = pw.sequences.regenerate(seq.id, 2, RegenerateRequest(user_hint="lead with the value, not the welcome"))
    print(f"Regenerated #2 → {better.subject!r} (fidelity {better.voice_fidelity_score:.1f})")


if __name__ == "__main__":
    main()
