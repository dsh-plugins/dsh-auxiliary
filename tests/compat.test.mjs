import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legacyModelEditors } from '../lib/compat.js';
for (const [version, inputTypes, reasoningLevels] of [
  ['0.1.5-alpha.1',true,true], ['0.1.6-alpha.2',true,true],
  ['0.1.7-alpha.2',true,true], ['0.1.7-rc.0',true,true],
  ['0.1.7-rc.1',false,true], ['0.1.7-rc.2',false,true], ['0.1.7',false,true],
  ['0.2.0-rc.2',false,true], ['0.2.1-alpha.5',false,true], ['0.2.1-rc.0',false,true],
  ['0.2.1-rc.1',false,false], ['0.2.1-rc.1+build.2',false,false],
  ['0.2.1-rc.5',false,false], ['0.2.1',false,false], ['0.2.2-alpha.2',false,false],
  [undefined,false,false], ['garbage',false,false],
]) test(`official model editors: ${version}`, () => assert.deepEqual(legacyModelEditors(version), {inputTypes,reasoningLevels}));

import { officialModelIntegrations } from '../lib/compat.js';
for (const [version,autoReview,translation] of [
  ['0.1.7-rc.1',false,false],['0.1.7-rc.2',true,false],['0.1.7',true,false],
  ['0.2.0-rc.1',true,false],['0.2.1-alpha.5',true,false],['0.2.1-rc.0',true,false],
  ['0.2.1-rc.1',true,true],['0.2.1-rc.1+build',true,true],['0.2.1-rc.5',true,true],
  ['0.2.2-alpha.2',true,true],[undefined,false,false],['bad',false,false],
]) test(`official integrations: ${version}`,()=>assert.deepEqual(officialModelIntegrations(version),{autoReview,translation}));
