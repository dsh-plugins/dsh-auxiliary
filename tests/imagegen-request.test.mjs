import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { clearDshFacade, setDshFacade } from '../lib/dsh.js';
import { registerImagegenTool } from '../lib/imagegen-tool.js';

test('requests Base64 and downloads relative image URLs for generations and edits', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-imagegen-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYJkAAAAASUVORK5CYII=', 'base64');
  const requests = [];
  const replies = new Map([
    ['/v1/images/generations', { data: [{ b64_json: image.toString('base64'), url: '/unused.png' }, { url: '/images/generated.png' }] }],
    ['/v1/images/edits', { data: [{ url: 'edited.png' }] }],
  ]);
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    requests.push({ method: request.method, path: request.url, headers: request.headers, body: Buffer.concat(chunks) });
    if (replies.has(request.url)) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(replies.get(request.url)));
    } else if (request.url === '/images/generated.png' || request.url === '/v1/images/edited.png') {
      response.setHeader('content-type', 'image/png');
      response.end(image);
    } else {
      response.writeHead(404).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
  setDshFacade({ dsh: { tools: { defineTool: (tool) => tool }, credentials: { credentialRef: (ref) => ref } } });
  t.after(clearDshFacade);
  let tool;
  const ctx = {
    systemPrompt: { section: () => () => {} },
    tools: { register: (value) => { tool = value; return () => {}; } },
    llm: {},
    get: () => ({ get: () => ({ providers: { example: { baseURL, apiKeyEnv: 'EXAMPLE_KEY' } } }) }),
    credentials: { resolve: async () => ({ value: 'example' }) },
    attachments: { saveImage: async () => ({ attachmentId: 'example' }) },
    fs: {
      resolve: async (path) => ({ displayPath: path }),
      stat: async () => ({ type: 'file' }),
      readBytes: async () => image,
    },
  };
  t.after(registerImagegenTool(ctx, () => ({ imagegen: { enabled: true, provider: 'example', model: 'example' } })));
  const exec = { signal: new AbortController().signal, agent: { session: { header: { cwd } } } };

  const generated = await tool.execute({ prompt: 'example', n: 2 }, exec);
  const edited = await tool.execute({ prompt: 'example', reference: 'reference.png' }, exec);
  const multiEdited = await tool.execute({ prompt: 'example', reference: ['reference.png', 'second.webp'] }, exec);

  assert.deepEqual(requests.map(({ method, path }) => `${method} ${path}`), [
    'POST /v1/images/generations', 'GET /images/generated.png',
    'POST /v1/images/edits', 'GET /v1/images/edited.png',
    'POST /v1/images/edits', 'GET /v1/images/edited.png',
  ]);
  assert.equal(JSON.parse(requests[0].body).response_format, 'b64_json');
  const editForm = await new Response(requests[2].body, { headers: requests[2].headers }).formData();
  assert.equal(editForm.get('response_format'), 'b64_json');
  assert.equal(editForm.get('image').name, 'reference.png');
  const multiForm = await new Response(requests[4].body, { headers: requests[4].headers }).formData();
  assert.deepEqual(multiForm.getAll('image[]').map((file) => [file.name, file.type]), [
    ['reference.png', 'image/png'], ['second.webp', 'image/webp'],
  ]);
  assert.equal(multiForm.getAll('image').length, 0);
  assert.equal(generated.paths.length, 2);
  assert.equal(edited.paths.length, 1);
  assert.equal(multiEdited.paths.length, 1);
  for (const path of [...generated.paths, ...edited.paths, ...multiEdited.paths]) {
    assert.deepEqual(await readFile(path), image);
  }
});
