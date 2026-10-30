import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
const require = createRequire(import.meta.url);
const source = await readFile(new URL('../lib/client.js',import.meta.url),'utf8');
const delay = ms=>new Promise(resolve=>setTimeout(resolve,ms));
for (const [version,inputTypes,reasoningLevels] of [
  ['0.1.7-alpha.2',true,true],['0.1.7-rc.1',false,true],
  ['0.2.1-alpha.5',false,true],['0.2.1-rc.1',false,false],['0.2.2-alpha.2',false,false],
]) test(`client controls and deferred writes at ${version}`, async t=>{
  const dom = new JSDOM(`<body><li><span>Test</span><div><div><input aria-label="Model ID test" value="old"></div><div><input aria-label="Context window test" value="4096"></div></div></li></body>`, {runScripts:'outside-only',pretendToBeVisual:true});
  t.after(()=>dom.window.close());
  const {window}=dom; let declaration, wake, row='old', disposed=false; const cleanups=[], writes=[], roots=new Set();
  window.__dshLoader__={dshVersion:version}; window.__ModuleLoader__={load:value=>{declaration=value}};
  window.eval(source);
  const mod=declaration.factory(id=>id==='react-dom/client'?{createRoot:host=>{
    const root={render(){},unmount(){roots.delete(root)}};roots.add(root);return root;
  }}:id==='@dsh-plugin/dsh-loader/client'?{Icon:()=>null,DshMenu:()=>null}:require(id));
  const value={providers:{test:{models:[{id:row,input:['text','image'],imageGeneration:true,reasoningEfforts:{low:'low'},reasoning:'low'}]}}};
  const api={llm:{providers:async()=>({result:{ok:true,value:{providers:[{provider:'test',displayName:'Test',settingsNs:'llm-pi-ai'}]}}})},settings:{
    describe:async()=>({result:{ok:true,value:{writable:true,namespaces:[{ns:'llm-pi-ai',revision:0,user:value,value,base:{}}]}}}),
    update:async args=>{writes.push(args);return {result:{ok:true,value:{ns:'llm-pi-ai',revision:1,user:value,value}}}},
  }};
  mod.apply({effect:fn=>cleanups.push(fn()),locale:{register:()=>()=>{},bind:()=>key=>key},get:()=>({api}),dshLoaderUi:{onDomSettled:fn=>{wake=fn;return()=>{disposed=true}}}});
  for(let i=0;i<100&&!window.document.querySelector('[data-dsh-aux-capabilities]');i++)await delay(10);
  assert(window.document.querySelector('[data-dsh-aux-capabilities]'),'catalog augmentation is mounted');
  assert.equal(window.document.querySelectorAll('[data-dsh-aux-image-input]').length>0,inputTypes);
  assert.equal(window.document.querySelectorAll('[data-dsh-aux-thinking-levels]').length>0,reasoningLevels);
  assert(window.document.querySelector('[data-dsh-aux-image-gen]'),'image generation stays available');
  // Renaming a saved row carries plugin-owned flags, but must leave official fields alone.
  const input=window.document.querySelector('[aria-label="Model ID test"]'); input.value='renamed';
  window.document.querySelector('[data-dsh-aux-capabilities]').remove(); wake(); await delay(30);
  value.providers.test.models[0].id='renamed'; wake(); await delay(220);
  window.document.querySelector('li').remove(); wake(); await delay(950);
  for(const {patch} of writes) {
    const model=patch.providers.test.models[0];
    if(!inputTypes)assert.equal(Object.hasOwn(model,'input'),true,'full row preserves host value');
    if(!reasoningLevels)assert.deepEqual(model.reasoningEfforts,{low:'low'},'official reasoning fields are preserved');
  }
  // Only enabled enhancements can contribute writes. One generation flag at latest versions.
  assert.equal(writes.length,1+Number(inputTypes)+Number(reasoningLevels));
  for(const off of cleanups.reverse())off?.();
  assert(disposed); assert.equal(roots.size,0); assert.equal(window.document.querySelectorAll('[data-dsh-aux-capabilities]').length,0);
  wake(); await delay(30); const count=writes.length; await delay(200); assert.equal(writes.length,count,'unload prevents later writes');
});
