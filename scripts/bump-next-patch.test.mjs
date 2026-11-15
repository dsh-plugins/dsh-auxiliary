import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('./bump-next-patch.mjs', import.meta.url));
function fixture(t, version = '1.2.9', latest = version) {
  const cwd = mkdtempSync(join(tmpdir(), 'npm-patch-bump-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const write = (path, value) => writeFileSync(join(cwd, path), `${JSON.stringify(value, null, 2)}\n`);
  const read = (path) => JSON.parse(readFileSync(join(cwd, path), 'utf8'));
  write('package.json', { name: '@test/plugin', version, dependencies: { example: '^1.0.0' } });
  write('npm-latest.json', { name: '@test/plugin', latest });
  const run = (tag = 'v1.2.9') => spawnSync(process.execPath, [script], {
    cwd, env: { ...process.env, RELEASE_TAG: tag }, encoding: 'utf8',
  });
  return { cwd, write, read, run };
}

test('bumps patch and synchronizes npm lockfiles without changing dependencies', (t) => {
  const f = fixture(t);
  const dependency = { version: '3.0.0', integrity: 'unchanged' };
  for (const path of ['package-lock.json', 'npm-shrinkwrap.json']) {
    f.write(path, { version: '1.2.9', packages: { '': { version: '1.2.9' }, 'node_modules/example': dependency } });
  }
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.read('package.json').version, '1.2.10');
  assert.deepEqual(f.read('package.json').dependencies, { example: '^1.0.0' });
  for (const path of ['package-lock.json', 'npm-shrinkwrap.json']) {
    const lock = f.read(path);
    assert.equal(lock.version, '1.2.10');
    assert.equal(lock.packages[''].version, '1.2.10');
    assert.deepEqual(lock.packages['node_modules/example'], dependency);
  }
  assert.equal(f.read('npm-latest.json').latest, '1.2.9');
  assert.equal(f.run().status, 0);
  assert.equal(f.read('package.json').version, '1.2.10');
});

test('works without npm locks and leaves pnpm lockfiles unchanged', (t) => {
  const f = fixture(t);
  const lock = "lockfileVersion: '9.0'\nimporters:\n  .: {}\n";
  writeFileSync(join(f.cwd, 'pnpm-lock.yaml'), lock);
  assert.equal(f.run().status, 0);
  assert.equal(f.read('package.json').version, '1.2.10');
  assert.equal(readFileSync(join(f.cwd, 'pnpm-lock.yaml'), 'utf8'), lock);
});

test('does not overwrite a version already changed on main', (t) => {
  for (const version of ['1.2.10', '1.3.0', '2.0.0', '1.2.8']) {
    const f = fixture(t, version, '1.2.9');
    assert.equal(f.run().status, 0);
    assert.equal(f.read('package.json').version, version);
  }
});

test('rejects prerelease and malformed release tags without modifying the manifest', (t) => {
  const f = fixture(t);
  for (const tag of ['v1.2.9-dev.1', 'v01.2.9', '1.2.9', '']) {
    assert.notEqual(f.run(tag).status, 0);
    assert.equal(f.read('package.json').version, '1.2.9');
  }
});

test('requires matching npm latest metadata', (t) => {
  const f = fixture(t, '1.2.9', '1.2.8');
  assert.notEqual(f.run().status, 0);
  assert.equal(f.read('package.json').version, '1.2.9');
  f.write('npm-latest.json', { name: '@test/other', latest: '1.2.9' });
  assert.notEqual(f.run().status, 0);
});

test('supports old npm lockfiles and preserves CRLF', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.cwd, 'package-lock.json'), '{\r\n  "version": "1.2.9",\r\n  "lockfileVersion": 1\r\n}\r\n');
  assert.equal(f.run().status, 0);
  assert.equal(f.read('package-lock.json').version, '1.2.10');
  assert.ok(readFileSync(join(f.cwd, 'package-lock.json'), 'utf8').includes('\r\n'));
});

test('a malformed lockfile fails before any manifest is written', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.cwd, 'package-lock.json'), 'invalid json');
  assert.notEqual(f.run().status, 0);
  assert.equal(f.read('package.json').version, '1.2.9');
});
