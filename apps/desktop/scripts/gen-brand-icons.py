#!/usr/bin/env python3
"""Regenerate apps/desktop/src/lib/integration-brand-icons.ts.

Maps every integrations-catalog slug to a brand logo:
  - si: a Simple Icons slug (crisp colored vector, cdn.simpleicons.org),
        VERIFIED to exist against the jsdelivr-hosted simple-icons package.
  - d:  the provider domain (Google s2 favicon fallback) for brands Simple
        Icons does not carry (most marketing SaaS).
  - (absent): the card renders a deterministic colored monogram.

Usage:
  CATALOG_URL=http://localhost:8080/api/v1/integrations/catalog \
  TENANT_SLUG=acme python3 apps/desktop/scripts/gen-brand-icons.py
"""
import hashlib
import io
import json
import os
import re
import tarfile
import urllib.request

CATALOG_URL = os.environ.get("CATALOG_URL", "http://localhost:8080/api/v1/integrations/catalog")
TENANT = os.environ.get("TENANT_SLUG", "acme")
OUT = os.path.join(os.path.dirname(__file__), "..", "src", "lib", "integration-brand-icons.ts")
SIMPLE_ICONS_VERSION = "15.5.0"
SIMPLE_ICONS_TARBALL = (
    f"https://registry.npmjs.org/simple-icons/-/simple-icons-{SIMPLE_ICONS_VERSION}.tgz"
)
SIMPLE_ICONS_SHA256 = "49fcbbc0f56ee45c2b2e9038cee40ac5f9a9940b0f714b317dfb512efbf17cd7"
MAX_SIMPLE_ICONS_BYTES = 10 * 1024 * 1024

OVERRIDE = {
  'meta':'meta','facebook-conversions-api':'facebook','facebook-lead-ads':'facebook',
  'google-ads':'googleads','google-enhanced-conversions':'googleads',
  'google-lead-form-extensions':'googleads','google-lead-form-extensions-bridge':'googleads',
  'google-display-video-360':'googlemarketingplatform','campaign-manager-360':'googlemarketingplatform',
  'apple-search-ads':'appstore','microsoft-advertising':'microsoft','microsoft-uet':'microsoft',
  'linkedin-conversions-api':'linkedin','linkedin-lead-gen':'linkedin',
  'x':'x','twitter':'x','twitter-lead-gen':'x','snap-audiences':'snapchat',
  'snap-conversions-api':'snapchat','snap-lead-ads':'snapchat','the-trade-desk':'thetradedesk',
  'google-analytics':'googleanalytics','google-sheets':'googlesheets','google-tag-manager':'googletagmanager',
  'gmail':'gmail','microsoft-dynamics':'microsoftdynamics365','dynamics-365':'microsoftdynamics365',
}
SUFFIXES = ['-conversions-api','-conversion-api','-customer-match','-matched-audiences',
  '-lead-form-extensions-bridge','-lead-form-extensions','-lead-ads','-lead-gen','-search-ads',
  '-enhanced-conversions','-display-video-360','-360','-ads','-api','-sdk','-bridge','-crm',
  '-forms','-form','-sms','-webhook','-webhooks','-integration','-audiences']
NON_BRAND = {'inbound-webhooks','outbound-webhooks','rest-api','graphql-api','custom-webhook'}
DOMAIN_OVERRIDE = {'x':'x.com','twitter':'x.com','twitter-lead-gen':'x.com','x-ads':'x.com',
  'the-trade-desk':'thetradedesk.com','snap-audiences':'snap.com','snap-conversions-api':'snap.com',
  'snap-lead-ads':'snap.com','microsoft-uet':'microsoft.com','mntn':'mountain.com'}
NOISE = {'ads','ad','api','crm','cms','conversions','conversion','lead','leads','gen','forms','form',
  'customer','match','audiences','audience','enhanced','bridge','extensions','extension','360','matched',
  'custom','integration','connector','app','sync','export','import','events','event','webhooks','webhook',
  'and','the','for','data','platform','cloud','marketing','commerce','analytics','inc','io','co'}

def norm(s): return re.sub(r'[^a-z0-9]','', s.lower())
def candidates(slug, name):
    out=[]
    if slug in OVERRIDE: out.append(OVERRIDE[slug])
    out.append(norm(name)); base=slug
    for suf in SUFFIXES:
        if base.endswith(suf): base=base[:-len(suf)]; break
    out.append(norm(base)); out.append(norm(slug))
    words=re.sub(r'[^a-z0-9 ]','',name.lower()).split()
    if words:
        out.append(norm(words[0]))
        if len(words)>=2: out.append(norm(words[0]+words[1]))
    seen=set(); res=[]
    for c in out:
        if c and len(c)>=2 and c not in seen: seen.add(c); res.append(c)
    return res
def guess_domain(slug, name):
    if slug in DOMAIN_OVERRIDE: return DOMAIN_OVERRIDE[slug]
    words=[w for w in re.sub(r'[^a-z0-9 ]','',name.lower()).split() if w not in NOISE] or [slug.split('-')[0]]
    brand=norm(''.join(words[:2])) if len(''.join(words[:1]))<=3 and len(words)>=2 else norm(words[0])
    return (brand+'.com') if brand else None

req=urllib.request.Request(CATALOG_URL, headers={'X-Tenant-Slug':TENANT})
# urllib's default HTTPS context verifies both the certificate chain and
# hostname. Never add an unverified context here: this response controls the
# generated TypeScript source committed to the product.
items=json.load(urllib.request.urlopen(req, timeout=20)).get('items', [])
allc=sorted({c for it in items for c in candidates(it['slug'], it['name'])})

archive_req = urllib.request.Request(
    SIMPLE_ICONS_TARBALL,
    headers={"User-Agent": "postwave-brand-icon-generator/1"},
)
with urllib.request.urlopen(archive_req, timeout=60) as response:
    archive = response.read(MAX_SIMPLE_ICONS_BYTES + 1)
if len(archive) > MAX_SIMPLE_ICONS_BYTES:
    raise RuntimeError("simple-icons archive exceeds the 10 MiB safety cap")
actual_hash = hashlib.sha256(archive).hexdigest()
if actual_hash != SIMPLE_ICONS_SHA256:
    raise RuntimeError(
        f"simple-icons archive checksum mismatch: got {actual_hash}, "
        f"want {SIMPLE_ICONS_SHA256}"
    )
with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as package:
    packaged_icons = {
        name.removeprefix("package/icons/").removesuffix(".svg")
        for name in package.getnames()
        if name.startswith("package/icons/") and name.endswith(".svg")
    }
valid = set(allc).intersection(packaged_icons)
out={}
for it in items:
    s=it['slug']
    si=next((c for c in candidates(s, it['name']) if c in valid), None)
    if si: out[s]={'si':si}
    elif s not in NON_BRAND:
        d=guess_domain(s, it['name'])
        if d: out[s]={'d':d}
ts=["// AUTO-GENERATED — do not edit by hand.",
    "// Regenerate: python3 apps/desktop/scripts/gen-brand-icons.py",
    f"// Simple Icons {SIMPLE_ICONS_VERSION}; archive sha256={SIMPLE_ICONS_SHA256}.",
    "// si = Simple Icons slug (cdn.simpleicons.org); d = favicon domain; absent => monogram.","",
    "export type BrandIconRef = { si?: string; d?: string };",
    "export const BRAND_ICONS: Record<string, BrandIconRef> = {"]
for s in sorted(out):
    ts.append(f'  {json.dumps(s)}: {{ '+", ".join(f"{k}: {json.dumps(v)}" for k,v in out[s].items())+' },')
ts.append("};")
open(OUT,'w').write("\n".join(ts)+"\n")
print(f"wrote {len(out)} entries (si={sum('si' in v for v in out.values())}, d={sum('d' in v for v in out.values())})")
