import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPatchAPI} from '@dsh-plugin/dsh-loader/patch';
import {installOfficialTranslationModel} from '../lib/translation-router.js';
function fixture(){
 const calls=[],records=[],cache=new Map();let config={enabled:true,model:'custom'};
 const llm={listModels:async()=>[{id:'custom'},{id:'deepseek-flash'}],prepareCall:async config=>({config})};
 const translator={ctx:{get:name=>name==='llm'?llm:undefined},storage:{async run(session,identity,signal,operation){
   const key=JSON.stringify([session,identity]);if(cache.has(key))return cache.get(key);
   const value=await operation({request:async row=>records.push(row)});cache.set(key,value);return value;
 }},async availableProviders(){return (await this.ctx.get('llm').listModels('deepseek-official')).some(row=>row.id==='deepseek-flash')?['bing','deepseek-official']:['bing']},
 async translate(spec,signal){
   if(spec.provider!=='deepseek-official')return spec.provider;
   const identity={...spec,recipe:'native-flash-recipe'};
   return this.storage.run('s',identity,signal,async log=>{
     const prepared=await this.ctx.get('llm').prepareCall({provider:spec.provider,model:'deepseek-flash',reasoningEffort:'off'},signal);
     await log.request({...identity,metadata:{modelRequest:prepared}});calls.push(prepared.config);return prepared.config.model;
   });
 }};
 return {translator,calls,records,llm,config:value=>{if(value)config=value;return config},patch:createPatchAPI()};
}
test('scoped model selection preserves other translation services and audit/cache identity',async()=>{
 const f=fixture(),off=installOfficialTranslationModel(f.translator,f.patch,f.config);
 const spec={provider:'deepseek-official',text:'x'};
 assert.equal(await f.translator.translate(spec),'custom');assert(f.records[0].recipe.includes('custom'));
 assert.equal(f.records[0].metadata.modelRequest.config.model,'custom');assert.equal(f.calls[0].reasoningEffort,'off');
 assert.equal(await f.translator.translate(spec),'custom');assert.equal(f.calls.length,1);
 f.config({enabled:true,model:'deepseek-flash'});assert.equal(await f.translator.translate(spec),'deepseek-flash');assert.equal(f.calls.length,2);
 for(const provider of ['bing','google','deepseek-account'])assert.equal(await f.translator.translate({provider}),provider);
 assert.equal((await f.llm.listModels())[0].id,'custom','shared model catalog is untouched');off();
});
test('a missing selected model does not inherit native Flash eligibility',async()=>{
 const f=fixture();f.config({enabled:true,model:'missing'});const off=installOfficialTranslationModel(f.translator,f.patch,f.config);
 assert.deepEqual(await f.translator.availableProviders(),['bing']);off();
});
test('Cordis traceable service is unwrapped and foreign wrappers survive unload',async()=>{
 const f=fixture(),raw=f.translator,original=raw.translate;
 const traced=new Proxy(raw,{get(target,key){if(key===Symbol.for('cordis.original'))return target;return Reflect.get(target,key)}});
 const off=installOfficialTranslationModel(traced,f.patch,f.config),installed=raw.translate;
 const outer=function(...args){return installed.apply(this,args)};raw.translate=outer;off();off();
 assert.equal(raw.translate,outer);assert.equal(await raw.translate({provider:'deepseek-official',text:'after'}),'deepseek-flash');
 raw.translate=original;
});
test('unloading cancels an in-flight override and preserves the caller cancellation reason',async()=>{
 for(const callerCancels of [false,true]){
  const f=fixture();let started;
  const ready=new Promise(resolve=>{started=resolve});
  f.translator.translate=async function(_spec,signal){started();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))};
  const off=installOfficialTranslationModel(f.translator,f.patch,f.config),caller=new AbortController(),reason=new Error('caller stop');
  const result=f.translator.translate({provider:'deepseek-official'},caller.signal);await ready;
  if(callerCancels)caller.abort(reason);else off();
  await assert.rejects(result,error=>callerCancels?error===reason:/unloaded/.test(error.message));off();
 }
});
test('failed installation restores its first patch',()=>{
 const f=fixture(),original=f.translator.translate;
 Object.defineProperty(f.translator,'availableProviders',{writable:false});
 assert.throws(()=>installOfficialTranslationModel(f.translator,f.patch,f.config));assert.equal(f.translator.translate,original);
});
