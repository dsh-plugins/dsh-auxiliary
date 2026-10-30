import { test } from 'node:test';
import assert from 'node:assert/strict';
import {registerApproveRouter,isOfficialAutoReviewCall} from '../lib/approve-router.js';
const official=(sessionId)=>({provider:'main',model:'main',temperature:0,system:'REVIEW_POLICY\nfixed official policy',messages:[{role:'user',content:[{type:'text',text:'ENVIRONMENT\n{}'}]}],...(sessionId?{sessionId}:{}),signal:new AbortController().signal});
const legacy=()=>({...official(),system:'legacy policy',messages:[{role:'user',content:[{type:'text',text:'>>> APPROVAL REQUEST START'}]}]});
for(const mode of ['legacy','official']) test(`approval model route: ${mode}`,()=>{
  let listener,active=true; const calls=[];const ctx={on:(_event,fn)=>{listener=fn;return()=>{active=false}},llm:{stream:options=>{calls.push(options);return options}}};
  const original=official('session');const get=()=>({approve:{enabled:true,provider:'aux',model:'cheap'}});
  const off=registerApproveRouter(ctx,get,mode);
  const selected=mode==='official'?original:legacy();
  const result=listener(selected,()=> 'unchanged');assert.equal(result.provider,'aux');assert.equal(result.model,'cheap');
  for(const key of ['system','messages','signal','sessionId','temperature'])assert.equal(result[key],selected[key]);
  assert.equal(selected.provider,'main');
  assert.equal(listener(mode==='official'?legacy():original,()=> 'unchanged'),'unchanged');
  assert.equal(listener({...selected,provider:'aux',model:'cheap'},()=> 'unchanged'),'unchanged');
  assert.equal(listener({...selected,system:'ordinary user conversation',messages:[]},()=> 'unchanged'),'unchanged');
  off();assert.equal(active,false);assert.equal(calls.length,1);
});
test('ordinary requests cannot select the official review route by prompt text alone',()=>{
  assert.equal(isOfficialAutoReviewCall({...official(),temperature:1}),false);
  assert.equal(isOfficialAutoReviewCall({...official(),system:'REVIEW_POLICY looks similar'}),false);
  assert.equal(isOfficialAutoReviewCall({...official(),messages:[{role:'user',content:[{type:'text',text:'ordinary'}]}]}),false);
});
