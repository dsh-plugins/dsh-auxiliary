/** Test frozen npm implementations without network or paid inference. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {realpath,readFile} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createPatchAPI} from '@dsh-plugin/dsh-loader/patch';
import {installOfficialTranslationModel} from '../lib/translation-router.js';
import {isOfficialAutoReviewCall} from '../lib/approve-router.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const selected=process.argv.find(arg=>arg.startsWith('--version='))?.slice(10);
for(const version of selected?[selected]:['0.2.1-rc.1','0.2.1-rc.2','0.2.1-rc.3','0.2.1-rc.4','0.2.1-rc.5','0.2.2-alpha.2']){
 const installation=await realpath(resolve(root,'../dsh-network-settings/.cache/versions',version,'node_modules/@deepseek-ai/dsh'));
 const upstream=createRequire(join(installation,'package.json'));
 const bundle=upstream.resolve('@deepseek-ai/dsh-experimental-cot-translation-bundle/package.json');
 const {default:Translator}=await import(pathToFileURL(createRequire(bundle).resolve('@deepseek-ai/dsh-experimental-translator')));
 const source=await readFile(upstream.resolve('@deepseek-ai/dsh-experimental-auto-review'),'utf8');
 const policy=/const REVIEW_POLICY = `([\s\S]*?)`;/u.exec(source)?.[1];assert(policy);
 assert(isOfficialAutoReviewCall({system:policy,temperature:0,messages:[{role:'user',content:[{type:'text',text:'ENVIRONMENT\n{}'}]}]}));
 const modelConfig={},catalog=[{id:'deepseek-flash'},{id:'deepseek-custom'},{id:'deepseek-other'}],ref='TEST_API_KEY';
 const records=[],calls=[],cache=new Map();let configured=true;
 const llm={listProviders:()=>[{id:'deepseek-official'}],listConfigurableProviders:()=>[{provider:'deepseek-official',settingsNs:'official-test',settingsPath:[]}],listModels:async()=>catalog,
 prepareCall:async(config,signal)=>({config,stream:async function*(options){signal.throwIfAborted();calls.push(options);yield {type:'block-start',blockType:'text'};yield {type:'text-delta',text:'translated '+config.model};yield {type:'block-end',block:{type:'text',text:'translated '+config.model}};yield {type:'finish',reason:{kind:'stop'}}}})};
 const entry={options:{id:'official-test',name:'@deepseek-ai/dsh-llm-deepseek-api-key'},fiber:{state:2,config:{models:{get:()=>modelConfig},apiKeyEnv:{get:()=>ref}}}};
 entry.fiber.effectiveConfig=entry.fiber.config;
 const services={llm,loader:{entries:()=>[entry]},credentials:{describe:async()=>({configured})}};
 const translator=Object.assign(Object.create(Translator.prototype),{ctx:{get:name=>services[name],on:()=>()=>{}},config:Translator.Config({}),lifetime:new AbortController(),pending:new Set(),storage:{async run(session,identity,signal,work){signal.throwIfAborted();const key=JSON.stringify([session,identity]);if(cache.has(key))return cache.get(key);const result=await work({request:async data=>{records.push(data);return records.length},result:async()=>{}});cache.set(key,result);return result}}});
 let config={enabled:true,model:'deepseek-custom'};const original=translator.translate,off=installOfficialTranslationModel(translator,createPatchAPI(),()=>config);
 assert((await translator.availableProviders()).includes('deepseek-official'));
 const spec=translator.resolve({provider:'deepseek-official',text:'source fragment',targetLanguage:'zh-CN',sessionId:'s'});
 assert.equal(await translator.translate(spec),'translated deepseek-custom');
 assert.equal(calls[0].model,'deepseek-custom');assert.equal(calls[0].provider,'deepseek-official');assert.equal(calls[0].reasoningEffort,'off');
 assert.equal(records[0].metadata.modelRequest.config.model,'deepseek-custom');assert(records[0].recipe.includes('deepseek-custom'));
 await translator.translate(spec);assert.equal(calls.length,1);
 config={enabled:true,model:'deepseek-other'};await translator.translate(spec);assert.equal(calls.length,2);
 config={enabled:true,model:'missing'};assert(!(await translator.availableProviders()).includes('deepseek-official'));
 await assert.rejects(translator.translate({...spec,text:'missing'}),e=>e.code==='TRANSLATION_UNAVAILABLE');
 config={enabled:true,model:'deepseek-custom'};configured=false;assert(!(await translator.availableProviders()).includes('deepseek-official'));
 await assert.rejects(translator.translate({...spec,text:'credentials missing'}),e=>e.code==='TRANSLATION_UNAVAILABLE');
 configured=true;off();assert.equal(translator.translate,original);assert.equal(await translator.translate({...spec,text:'after unload'}),'translated deepseek-flash');
 console.log(`PASS ${version}: real translator eligibility, credentials, audit model, thinking off, cache isolation, unload and official reviewer policy`);
}
