/**
 * OAuthButton — branded OAuth CTA used in SignIn / SignUp.
 *
 * Renders Google's brand glyph plus "Continue with Google" copy.
 * Google is the only OAuth provider enabled for this release.
 */

import type { ReactElement } from "react";

export type OAuthProvider = "google";

interface Props {
  provider: OAuthProvider;
  onClick: () => void;
  disabled?: boolean;
}

function GoogleGlyph(): ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 18 18"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.836.858-3.048.858-2.344 0-4.328-1.584-5.036-3.711H.96v2.332A8.997 8.997 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.964 10.705A5.41 5.41 0 0 1 3.682 9c0-.591.102-1.166.282-1.705V4.963H.96A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.96 4.037l3.004-2.332z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .96 4.963L3.964 7.295C4.672 5.168 6.656 3.58 9 3.58z"
      />
    </svg>
  );
}

const META: Record<OAuthProvider, { label: string; glyph: ReactElement }> = {
  google: { label: "Continue with Google", glyph: <GoogleGlyph /> },
};

export function OAuthButton({
  provider,
  onClick,
  disabled,
}: Props): ReactElement {
  const m = META[provider];
  return (
    <button
      type="button"
      className="oauth-btn-v2"
      onClick={onClick}
      disabled={disabled}
    >
      {m.glyph}
      {m.label}
    </button>
  );
}
