import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const tag = process.env.RELEASE_TAG;
if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag ?? '')) {
  throw new Error(`Expected a stable vX.Y.Z release tag; got ${tag}`);
}

const released = tag.slice(1);
const pkg = readJson('package.json');
if (pkg.version !== released) {
  console.log(`Skip bump: main is ${pkg.version}, released version is ${released}.`);
  process.exit(0);
}

const latest = readJson('npm-latest.json');
if (latest.name !== pkg.name || latest.latest !== released) {
  throw new Error(`npm latest metadata must confirm ${pkg.name}@${released} before bumping.`);
}

const [major, minor, patch] = released.split('.');
const next = `${major}.${minor}.${BigInt(patch) + 1n}`;
pkg.version = next;
const updates = new Map([['package.json', pkg]]);
for (const path of ['package-lock.json', 'npm-shrinkwrap.json']) {
  if (!existsSync(path)) continue;
  const lock = readJson(path);
  lock.version = next;
  if (lock.packages?.['']) lock.packages[''].version = next;
  updates.set(path, lock);
}

// Read every manifest before writing, and preserve each file's newline style.
for (const [path, value] of updates) {
  const newline = readFileSync(path, 'utf8').includes('\r\n') ? '\r\n' : '\n';
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`.replaceAll('\n', newline));
}
console.log(`Bumped ${pkg.name}: ${released} -> ${next}`);
