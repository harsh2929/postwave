// SPDX-License-Identifier: AGPL-3.0-only
import { defaultLocale, locales } from "@/i18n/locales";

// These run before hydration to avoid changing document language/theme after
// first paint. They are shared with the strict CSP policy so their immutable
// SHA-256 allow-list cannot silently drift away from the rendered bodies.
export const DOCUMENT_LOCALE_SCRIPT = `(function(){try{var s=location.pathname.split('/')[1];var l=${JSON.stringify(locales)};var lang=l.indexOf(s)>=0?s:${JSON.stringify(defaultLocale)};document.documentElement.lang=lang;}catch(e){}})();`;

export const THEME_SCRIPT = `(function(){try{var p=location.pathname;var a=p==='/app'||p.indexOf('/app/')===0;var t=a?(localStorage.getItem('theme')||'light'):'light';var s=t==='system'&&window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches;var d=document.documentElement;if(t==='dark'||s){d.classList.add('dark');}else{d.classList.remove('dark');}}catch(e){}})();`;

export const ROOT_LAYOUT_SCRIPT_HASHES = [
  "'sha256-cepvyKym128tSq8q5LbN2S8TgsFXseJ4SmWfNTOz4f0='",
  "'sha256-C162/+MVy+gQQmdhMfgt0Rz+JNXOisA4BhBoWH5vbtQ='",
] as const;
