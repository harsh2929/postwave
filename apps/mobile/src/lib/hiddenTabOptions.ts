/**
 * lib/hiddenTabOptions.ts — options for a route registered in the tab
 * navigator but never shown on the rail.
 *
 * Lifted out of `app/(tabs)/_layout.tsx` when that file crossed its 450-line
 * ceiling. The seam is forced rather than chosen: `src/lib/nav.consistency.test.ts`
 * parses the layout's TEXT for `<Tabs.Screen name="…">`, so every one of those
 * literals has to stay there — which means the only things that can move are
 * the helpers around them. This is one.
 *
 * INTERNED BY TITLE on purpose. React Navigation compares the `options` object
 * by identity; returning a fresh `{ title, href: null }` each render makes
 * every hidden screen look changed on every render of the layout, which is
 * ~30 needless screen reconfigurations per render as the secondary-route list
 * has grown.
 */
export interface HiddenTabOptions {
  title: string;
  href: null;
}

const HIDDEN_OPTIONS = new Map<string, HiddenTabOptions>();

export function hidden(title: string): HiddenTabOptions {
  let options = HIDDEN_OPTIONS.get(title);
  if (!options) {
    options = { title, href: null };
    HIDDEN_OPTIONS.set(title, options);
  }
  return options;
}

/** Same, for route shells whose own Stack supplies the title. */
export const SHELL: { href: null } = { href: null };
