import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {migrationSources} from './migration-qualification.mjs';

for(const mode of ['complete','wrong-candidate','cleanup-fails']) {
 test(`live harness HTTP contract: ${mode}`,async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'migration-harness-'));
  const digest='a'.repeat(64), calls=[];
  const csv='email,status\nfixture@example.test,unsubscribed\n';
  const input=path.join(dir,'source.csv');await writeFile(input,csv);
  let phase='awaiting_confirmation';
  const server=http.createServer(async(req,res)=>{
   calls.push(`${req.method} ${req.url.split('?')[0]}`);
   assert.equal(req.headers['x-migration-expected-build-sha256'],digest);
   res.setHeader('X-Migration-Build-SHA256',mode==='wrong-candidate'?'b'.repeat(64):digest);
   res.setHeader('Content-Type','application/json');
   let body=Buffer.alloc(0);for await(const chunk of req) body=Buffer.concat([body,chunk]);
   const reply=(value)=>res.end(JSON.stringify(value));
   if(req.url==='/v1/migrations/sources') return reply(migrationSources.map(source=>({source})));
   if(req.method==='PUT' && req.url.includes('/uploads/')) {assert.equal(body.toString(),csv);return reply({received:body.length});}
   if(req.url.endsWith('/complete')) return reply({job_id:'fixture-job'});
   if(req.url.endsWith('/discover')) return reply({subscribers_count:1,resource_metadata:[{resource:'subscribers'}]});
   if(req.url.endsWith('/dry-run')) {phase='awaiting_confirmation';return reply({job_id:'fixture-job'});}
   if(req.url.endsWith('/commit')) {phase='completed';return reply({job_id:'fixture-job'});}
   if(req.url==='/v1/migrations/fixture-job') return reply({id:'fixture-job',source:'csv',status:phase,rollback_until:'2099-01-01T00:00:00Z',verification_report:{subscribers_imported:1,resource_completeness:[]}});
   if(req.url.endsWith('/rollback')) return reply({job_id:'fixture-job'});
   if(req.url.endsWith('/rollback-status')) return reply({state:'completed'});
   if(req.url.endsWith('/source-session') && req.method==='DELETE') {
    if(mode==='cleanup-fails') {res.statusCode=503;return reply({error:'cleanup unavailable'});}
    return reply({stored_source_data_removed:true,provider_access_revoked:false});
   }
   res.statusCode=500;reply({error:'unexpected local fixture route'});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
   const child=spawn(process.execPath,['scripts/validate-live-migrations.mjs'],{cwd:process.cwd(),env:{PATH:process.env.PATH,POSTWAVE_MIGRATION_URL:`http://127.0.0.1:${server.address().port}`,POSTWAVE_TEST_TENANT_ID:'test-tenant',MIGRATION_CANDIDATE_SHA256:digest,POSTWAVE_LIVE_MIGRATION_ARTIFACT_DIR:path.join(dir,'evidence'),MIGRATION_EXPORT_PATHS_JSON:JSON.stringify({csv:input}),CSV_LIVE_COMMIT:'1',CSV_LIVE_ROLLBACK:'1'}});
   let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);
   const exit=await new Promise(resolve=>child.on('close',resolve));
   if(mode==='complete') {
    assert.equal(exit,0,output);
    for(const stage of ['live_upload','live_dry_run','live_commit_rollback','source_cleanup']) assert.match(output,new RegExp(`PASS csv_${stage}`));
    const files=await readdir(path.join(dir,'evidence'));
    for(const filename of files) {
     const artifact=JSON.parse(await readFile(path.join(dir,'evidence',filename),'utf8'));
     assert.equal(artifact.candidate_sha256,digest);assert.equal(artifact.observed_executable_sha256,digest);
     assert.equal(JSON.stringify(artifact).includes('fixture@example.test'),false);
    }
   } else {
    assert.equal(exit,1,output);
    assert.doesNotMatch(output,/PASS csv_source_cleanup/u);
    if(mode==='wrong-candidate') assert.deepEqual(calls,['GET /v1/migrations/sources']);
   }
  } finally {await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
 });
}
