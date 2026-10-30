# `@postwave/audit-portal-react`

Sandboxed React iframe wrapper for Moosewave's read-only customer audit portal.

```tsx
<PostwaveAuditPortal
  sessionUrl={portalSession.portal_url}
  portalOrigin="https://audit.postwave.example"
  parentOrigin="https://app.customer.example"
  onLoaded={() => setReady(true)}
  onError={(error) => reportPortalError(error)}
/>
```

`sessionUrl` must be the exact HTTPS URL returned by
`POST /api/v1/audit/portal/sessions`. Its one-time credential is carried only
in the fragment, immediately scrubbed by the portal, then exchanged for a
partitioned HttpOnly cookie. The wrapper rejects malformed/non-HTTPS portal
URLs and any URL outside the explicit `portalOrigin`, and supplies the exact
`parentOrigin` that the portal must use for `postMessage`. The wrapper also
pins received events to both the portal origin and iframe window,
uses `referrerPolicy="no-referrer"`, and omits navigation, popup, and form
permissions from the iframe sandbox.

The portal deployment must list the host application's exact HTTPS origin in
`POSTWAVE_PORTAL_FRAME_ANCESTORS`; the host CSP must permit the portal origin
in `frame-src`. Host the portal on a separate origin from the embedding
application; combining `allow-scripts` and `allow-same-origin` is safe only
when the framed document cannot modify its parent DOM.

The package publishes compiled ESM and declaration files from `dist/`; raw
TypeScript source is not part of the package archive. `pnpm build` and
`pnpm test` validate the URL and message boundary before publication.
