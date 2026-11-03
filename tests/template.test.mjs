import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultsFor,validateValues} from '@dsh-plugin/dsh-loader/config';
import {Config} from '../lib/config.js';
import {createConfigTemplate, runtimeConfig} from '../lib/config-template.js';

test('config template preserves seeded routes and validates complete nested configuration',()=>{
  const template=createConfigTemplate(Config({vision:{provider:'p',model:'m'}}));
  const defaults=defaultsFor(template.fields);
  assert.deepEqual(defaults.vision.selection,{provider:'p',model:'m'});
  assert.equal(runtimeConfig(defaults).vision.model,'m');
  assert.equal(defaults.tool.enabled,true); assert.equal(defaults.engine.retainRatio,0.16);
  assert(!('视觉模型' in defaults));
  assert.throws(()=>validateValues(template.fields,{...defaults,tool:{...defaults.tool,maxImageBytes:-1}}));
  assert.throws(()=>validateValues(template.fields,{...defaults,engine:{...defaults.engine,thresholdRatio:2}}));
  assert.deepEqual(validateValues(template.fields,JSON.parse(JSON.stringify(defaults))),defaults);
});

test('only supported hosts receive the official translation form',()=>{
  const group=version=>createConfigTemplate(Config({}),version).fields.find(field=>field.key==='translation');
  assert.equal(group('0.2.1-alpha.5'),undefined);
  const latest=group('0.2.1-rc.1');assert.equal(latest.label,'思考过程机器翻译');
  assert.equal(defaultsFor([latest]).translation.selection.model,'deepseek-flash');
  assert.equal(defaultsFor([latest]).translation.enabled,false);
});

test('部署路由缺少提供商或模型时报告配置错误', () => {
  for (const vision of [{ provider: 'foo' }, { model: 'example' }]) {
    assert.throws(() => createConfigTemplate(Config({ vision })), /必须同时配置/);
  }
});
