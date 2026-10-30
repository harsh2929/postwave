import test from 'node:test';
import assert from 'node:assert/strict';
import { migrationSources, exportPaths, candidateError, lifecycleCoverageErrors } from './migration-qualification.mjs';

test('a green qualification requires all 20 paths, including cleanup',()=>{
 assert.equal(new Set(migrationSources).size,20);
 const smoke=migrationSources.map(source=>({id:`${source}_live_discovery`,status:'pass'}));
 assert.equal(lifecycleCoverageErrors(smoke).length,60);
 const complete=migrationSources.flatMap(source=>['live_dry_run','live_commit_rollback','source_cleanup'].map(phase=>({id:`${source}_${phase}`,status:'pass'})));
 assert.deepEqual(lifecycleCoverageErrors(complete),[]);
 complete[0].status='skip'; assert.equal(lifecycleCoverageErrors(complete).length,1);
});
test('candidate mismatches and unbound artifacts cannot qualify',()=>{
 const expected='a'.repeat(64);
 assert.equal(candidateError(expected,expected),'');
 assert.notEqual(candidateError(expected,'b'.repeat(64)),'');
 assert.notEqual(candidateError('', ''),'');
});
test('export manifest rejects unknown sources and malformed shape',()=>{
 assert.deepEqual(exportPaths('{"aweber":"/secure/export.csv"}'),{aweber:'/secure/export.csv'});
 for(const raw of ['[]','null','{"unknown":"x"}','{"csv":null}','malformed']) assert.throws(()=>exportPaths(raw));
});
