/**
 * 文件职责：验证 GitHub 发布顺序、资源失败隔离和可恢复的频道晋升。
 * 定义范围：通过内存 HTTP 边界模拟实际请求，不访问或修改 GitHub。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { publishRelease } from './release-github.mjs';
import { releaseFixture } from './release-fixture.mjs';

async function githubFixture(context, { published = false, corrupt = false, failChannel = false, existingChannel = false } = {}) {
  const fixture = releaseFixture();
  const directory = await mkdtemp(join(tmpdir(), 'foldmark-github-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all([...fixture.files].map(([name, bytes]) => writeFile(join(directory, name), bytes)));
  const events = [];
  const remote = new Map();
  let release = published ? { id: 1, tag_name: `v${fixture.version}`, draft: false, prerelease: true, upload_url: 'https://uploads.github.com/release{?name}', assets: [] } : null;
  if (published) {
    for (const [name, bytes] of fixture.files) {
      const id = remote.size + 1;
      remote.set(id, bytes);
      release.assets.push({ id, name, state: 'uploaded', url: `https://api.github.com/assets/${id}` });
    }
  }
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const request = async (url, options = {}) => {
    const method = options.method ?? 'GET';
    const parsed = new URL(url);
    const path = parsed.pathname;
    events.push(`${method} ${path}`);
    const body = options.body && typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
    if (path.includes('/releases/tags/')) return release ? json(release) : json({}, 404);
    if (path.endsWith('/releases') && method === 'POST') {
      release = { ...body, id: 1, upload_url: 'https://uploads.github.com/release{?name}', assets: [] };
      return json(release, 201);
    }
    if (parsed.hostname === 'uploads.github.com') {
      const id = remote.size + 1;
      const asset = { id, name: parsed.searchParams.get('name'), state: 'uploaded', url: `https://api.github.com/assets/${id}` };
      remote.set(id, Buffer.from(options.body));
      release.assets.push(asset);
      return json(asset, 201);
    }
    if (path.startsWith('/assets/')) return new Response(corrupt && path.endsWith('/1') ? Buffer.from('corrupt') : remote.get(Number(path.split('/').at(-1))));
    if (path.endsWith('/releases/1') && method === 'GET') return json(release);
    if (path.endsWith('/releases/1') && method === 'PATCH') { Object.assign(release, body); return json(release); }
    if (path.endsWith('/git/ref/heads/updates')) return existingChannel ? json({ object: { sha: 'base' } }) : json({}, 404);
    if (path.endsWith('/git/commits/base')) return json({ tree: { sha: 'base-tree' } });
    if (path.endsWith('/contents/stable.json')) { assert.equal(parsed.searchParams.get('ref'), 'base'); return json({}, 404); }
    if (path.endsWith('/contents/preview.json')) {
      assert.equal(parsed.searchParams.get('ref'), 'base');
      return json({ content: Buffer.from(JSON.stringify({ version: '0.1.0-alpha.0' })).toString('base64') });
    }
    if (path.endsWith('/git/trees')) {
      if (failChannel) return json({}, 500);
      assert.deepEqual(body.tree.map((item) => item.path), ['preview.json']);
      assert.equal(JSON.parse(body.tree[0].content).version, fixture.version);
      if (existingChannel) assert.equal(body.base_tree, 'base-tree');
      return json({ sha: 'tree' }, 201);
    }
    if (path.endsWith('/git/commits')) { assert.deepEqual(body.parents, existingChannel ? ['base'] : []); return json({ sha: 'commit' }, 201); }
    if (path.endsWith('/git/refs/heads/updates')) { assert.deepEqual(body, { sha: 'commit', force: false }); return json({}); }
    if (path.endsWith('/git/refs') && method === 'POST') return json({ ref: body.ref }, 201);
    throw new Error(`未预期的请求 ${method} ${path}`);
  };
  return { ...fixture, directory, request, events, release: () => release };
}

test('首次发布先验证草稿资源，再公开 Release，最后创建频道', async (context) => {
  const fake = await githubFixture(context);
  await publishRelease({ ...fake, tag: `v${fake.version}`, token: 'test' });
  const publish = fake.events.findIndex((item) => item === 'PATCH /repos/Mowonhua/foldmark/releases/1');
  assert.ok(publish > fake.events.findIndex((item) => item === 'GET /assets/4'));
  assert.ok(fake.events.findIndex((item) => item.endsWith('/git/trees')) > publish);
  assert.equal(fake.release().draft, false);
  assert.equal(fake.release().prerelease, true);
});

test('损坏的远端资源使流程停在草稿，禁止更新频道', async (context) => {
  const fake = await githubFixture(context, { corrupt: true });
  await assert.rejects(publishRelease({ ...fake, tag: `v${fake.version}`, token: 'test' }), /摘要/);
  assert.equal(fake.release().draft, true);
  assert.ok(!fake.events.some((item) => item.includes('/git/')));
});

test('重跑已公开版本只验证已有产物并补做频道，不改写 Release 资产', async (context) => {
  const fake = await githubFixture(context, { published: true });
  await publishRelease({ ...fake, tag: `v${fake.version}`, token: 'test' });
  assert.ok(fake.events.some((item) => item.endsWith('/git/refs')));
  assert.ok(!fake.events.some((item) => /^(POST|PATCH|DELETE).*releases/.test(item)));
  assert.ok(!fake.events.some((item) => item === 'POST /release'));
});

test('频道提交失败保留已公开 Release，下一次重跑可以恢复', async (context) => {
  const fake = await githubFixture(context, { failChannel: true });
  await assert.rejects(publishRelease({ ...fake, tag: `v${fake.version}`, token: 'test' }), /500/);
  assert.equal(fake.release().draft, false);
  assert.ok(!fake.events.some((item) => item.endsWith('/git/refs')));
});

test('已有频道以同一 commit 为基准读取与提交，只允许非强制晋升', async (context) => {
  const fake = await githubFixture(context, { published: true, existingChannel: true });
  await publishRelease({ ...fake, tag: `v${fake.version}`, token: 'test' });
  assert.ok(fake.events.includes('PATCH /repos/Mowonhua/foldmark/git/refs/heads/updates'));
  assert.ok(!fake.events.includes('POST /repos/Mowonhua/foldmark/git/refs'));
});
