/**
 * Generate a 3-email welcome series in the tenant's voice.
 *
 * Run:  POSTWAVE_API_KEY=... POSTWAVE_TENANT=acme tsx examples/generate-sequence.ts
 */
import { PostwaveClient } from "@postwave/sdk";

const pw = new PostwaveClient({
  apiKey: process.env.POSTWAVE_API_KEY!,
  tenantId: process.env.POSTWAVE_TENANT,
});

async function main(): Promise<void> {
  // Make sure the voice profile is built first.
  try {
    await pw.voiceProfile.get();
  } catch {
    console.log("No profile yet — building from currently-registered sources...");
    await pw.voiceProfile.build();
  }

  const seq = await pw.sequences.generate({
    template_id: "tpl_welcome_3",
    name: "Welcome series · launch cohort",
    variables: { product_name: "Acme", founder_name: "Alex" },
    style_controls: { humor: 0.2, directness: 0.5, length: "as-is" },
  });

  console.log(`Generated ${seq.emails.length} emails (id=${seq.id}):`);
  for (const e of seq.emails) {
    console.log(`#${e.position}  fidelity=${e.voice_fidelity_score.toFixed(1)}  subject="${e.subject}"`);
  }

  // Regenerate just the second email with a hint.
  const better = await pw.sequences.regenerate(seq.id, 2, {
    user_hint: "make it punchier; lead with the value, not the welcome",
  });
  console.log(`Regenerated #2 → "${better.subject}" (fidelity ${better.voice_fidelity_score.toFixed(1)})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
