// The build version, read straight from app.json (a plain JSON import — the
// same value expo-constants would surface as expoConfig.version, but without
// pulling the react-native/expo-constants native chain into non-RN test envs).
import appConfig from "../../app.json";

/**
 * Sent on every request so the backend Origin/CSRF gate treats this as a
 * first-party native client (see apps/api/.../middleware/origin_csrf.go).
 * The value is not a secret; the CSRF protection is that browsers cannot
 * set a custom header cross-origin without a CORS preflight.
 *
 * X-Postwave-Version powers the client-version fabric (dim 10): the gateway can
 * enforce a minimum build via POSTWAVE_MIN_CLIENT_VERSIONS and return a 426
 * "please update" instead of letting a stale build silently mis-parse.
 */
export const NATIVE_CLIENT_HEADERS: Record<string, string> = {
  "X-Postwave-Client": "mobile",
  "X-Postwave-Version": appConfig.expo?.version ?? "dev",
};
