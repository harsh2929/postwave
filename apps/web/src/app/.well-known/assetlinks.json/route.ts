export const dynamic = "force-dynamic";

function json(body: unknown, init: ResponseInit = {}) {
  return Response.json(body, {
    ...init,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=3600",
      ...(init.headers ?? {}),
    },
  });
}

export function GET() {
  const packageName =
    process.env.POSTWAVE_ANDROID_PACKAGE_NAME?.trim() || "com.moosewave.app";
  const fingerprints = (process.env.POSTWAVE_ANDROID_SHA256_CERT_FINGERPRINTS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (fingerprints.length === 0) {
    return json(
      {
        error:
          "POSTWAVE_ANDROID_SHA256_CERT_FINGERPRINTS is required to serve Android app links.",
      },
      { status: 503 },
    );
  }

  const target = {
    namespace: "android_app",
    package_name: packageName,
    sha256_cert_fingerprints: fingerprints,
  };

  return json([
    { relation: ["delegate_permission/common.handle_all_urls"], target },
    // Credential Manager / Smart Lock: without `get_login_creds` Android
    // refuses to share the browser-saved workspace password with the app, so
    // the mobile sign-in form's autoComplete="password" hint has nothing to
    // offer. Declared as a SEPARATE statement (not a second relation on the
    // first) because Digital Asset Links treats each relation independently
    // and some verifiers only read the first matching statement.
    { relation: ["delegate_permission/common.get_login_creds"], target },
  ]);
}
