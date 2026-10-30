export const directSources = Object.freeze(['activecampaign','beehiiv','brevo','customerio','hubspot','klaviyo','mailerlite','mailchimp','convertkit']);
export const exportSources = Object.freeze(['aweber','bento','campaign-monitor','constant-contact','drip','flodesk','loops','omnisend','sendy','substack','csv']);
export const migrationSources = Object.freeze([...directSources,...exportSources]);
export function candidateError(expected, observed) {
  if (!/^[a-f0-9]{64}$/u.test(expected || '')) return 'MIGRATION_CANDIDATE_SHA256 must identify the expected migration executable';
  if (observed !== expected) return 'Migration response came from an unverified or different executable; qualification stopped';
  return '';
}
export function lifecycleCoverageErrors(results) {
  const passed = new Set(results.filter(r=>r.status==='pass').map(r=>r.id));
  return migrationSources.flatMap(source=> ['live_dry_run','live_commit_rollback','source_cleanup'].filter(phase=>!passed.has(`${source}_${phase}`)).map(phase=>`${source}_${phase}`));
}
export function exportPaths(raw) {
  let parsed;
  try { parsed=JSON.parse(raw || '{}'); } catch { throw new Error('MIGRATION_EXPORT_PATHS_JSON must be an object mapping source to a local export path'); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('MIGRATION_EXPORT_PATHS_JSON must be an object');
  for (const [source,value] of Object.entries(parsed)) {
    if (!exportSources.includes(source) || typeof value !== 'string' || !value.trim()) throw new Error('Export manifest contains an unknown source or invalid path');
  }
  return parsed;
}
