import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultsFor,validateValues} from '@dsh-plugin/dsh-loader/config';
import {Config} from '../lib/config.js';
import {createConfigTemplate} from '../lib/config-template.js';

test('config template preserves seeded routes and validates complete nested configuration',()=>{
  const template=createConfigTemplate(Config({vision:{provider:'p',model:'m'}}));
  const defaults=defaultsFor(template.fields);
  assert.equal(defaults.vision.provider,'p'); assert.equal(defaults.vision.model,'m');
  assert.equal(defaults.tool.enabled,true); assert.equal(defaults.engine.retainRatio,0.16);
  assert(!('视觉模型' in defaults));
  assert.throws(()=>validateValues(template.fields,{...defaults,tool:{...defaults.tool,maxImageBytes:-1}}));
  assert.throws(()=>validateValues(template.fields,{...defaults,engine:{...defaults.engine,thresholdRatio:2}}));
  assert.deepEqual(validateValues(template.fields,JSON.parse(JSON.stringify(defaults))),defaults);
});
