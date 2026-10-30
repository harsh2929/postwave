# @postwave/track

The browser producer for Moosewave's first-party, **cookieless** event endpoint.

Moosewave ships a public ingestion endpoint — `POST /api/public/track/event` —
that resolves the tenant from the request `Host` (a verified first-party CNAME),
writes the event onto the subscriber's activity timeline, and de-duplicates on a
client-supplied id. This is the small, dependency-free client a site embeds to
send those events.

## Scope

This tracks **known (email-identified) users** — e.g. logged-in behaviour like
"Viewed Pricing" or "Placed Order" — with no third-party cookies. The endpoint
attributes events by email and accepts-and-ignores unknown subscribers
(`recorded: false`).

Tracking **anonymous** visitors and stitching them to a profile on login is the
remaining half of the story: the identify path already supports the
`anonymous_id → known` stitch, but a backend anonymous-ingestion endpoint is
still needed. This library is forward-compatible with it.

## Usage

Serve the built module from your verified first-party domain (the same host the
endpoint resolves), then:

```html
<script type="module">
  import { createTracker } from "/vendor/postwave-track.js";

  const pw = createTracker(); // defaults to /api/public/track/event on this origin

  // When you know who the user is (e.g. after login):
  pw.track({
    email: currentUser.email,
    eventName: "Viewed Pricing",
    properties: { plan: "growth" },
  });
</script>
```

Bundler usage:

```ts
import { createTracker, TrackError } from "@postwave/track";

const pw = createTracker({ endpoint: "https://track.example.com/api/public/track/event" });

try {
  const res = await pw.track({ email, eventName: "Placed Order", properties: { value: 49.99 } });
  if (!res.recorded) {
    // subscriber isn't in the audience yet — expected, not an error
  }
} catch (e) {
  if (e instanceof TrackError) {
    // genuine 4xx/5xx (e.g. unrecognized host / rate-limited)
  }
}
```

## Idempotency

Each `track()` call auto-generates a `source_event_id` so a retried send
de-duplicates server-side. Pass your own `sourceEventId` to control it.

## License

MIT.
