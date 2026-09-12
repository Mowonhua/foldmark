/**
 * 文件职责：验证发布版本、资源完整性与更新频道的失败边界。
 * 定义范围：采用真实字节摘要的发布规则测试，避免损坏包和旧版本进入更新频道。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions, createUpdateManifest, selectChannelUpdates, validateReleaseVersions, verifyReleaseFiles } from './release-policy.mjs';
import { releaseFixture } from './release-fixture.mjs';

test('标签必须与所有版本文件完全一致，锁文件漂移会阻止发布', () => {
  const versions = { npm: '0.1.0-alpha.1', tauri: '0.1.0-alpha.1', cargo: '0.1.0-alpha.1' };
  assert.deepEqual(validateReleaseVersions(versions, 'v0.1.0-alpha.1'), { version: versions.npm, prerelease: true });
  assert.throws(() => validateReleaseVersions({ ...versions, lock: '0.1.0' }), /lock/);
  assert.throws(() => validateReleaseVersions(versions, 'v0.1.0'), /标签/);
  assert.throws(() => validateReleaseVersions({ npm: '1.0.0-alpha.01' }), /SemVer/);
  assert.throws(() => validateReleaseVersions({ npm: '01.0.0' }), /SemVer/);
});

test('SemVer 使用数值预发布排序，正式版高于同版本预发布，忽略构建元数据', () => {
  const ascending = ['0.1.0-alpha', '0.1.0-alpha.1', '0.1.0-alpha.2', '0.1.0-alpha.10', '0.1.0-beta', '0.1.0-rc.1', '0.1.0', '0.1.1', '1.0.0'];
  for (let i = 1; i < ascending.length; i += 1) assert.ok(compareVersions(ascending[i - 1], ascending[i]) < 0);
  assert.equal(compareVersions('1.0.0+abc', '1.0.0+def'), 0);
  assert.ok(compareVersions('1.0.0-99999999999999999999', '1.0.0-100000000000000000000') < 0);
});

test('真实摘要、完整签名及版本下载地址共同约束资源包', () => {
  const { files, repository, version, manifest, installerName } = releaseFixture();
  assert.deepEqual(verifyReleaseFiles(files, repository, version), manifest);
  const corrupted = new Map(files).set(installerName, Buffer.from('corrupted'));
  assert.throws(() => verifyReleaseFiles(corrupted, repository, version), /摘要/);
  const missing = new Map(files);
  missing.delete(`${installerName}.sig`);
  assert.throws(() => verifyReleaseFiles(missing, repository, version), /资源/);
  assert.throws(() => verifyReleaseFiles(files, 'other/foldmark', version), /地址/);
  assert.throws(() => verifyReleaseFiles(files, repository, '0.1.0-alpha.2'), /版本|资源/);
});

test('预发布只提升 preview，正式版可提升两频道，补发旧版本不倒退', () => {
  const alpha = releaseFixture().manifest;
  const stable = releaseFixture('0.1.0').manifest;
  const future = releaseFixture('0.2.0-alpha.1').manifest;
  assert.deepEqual(selectChannelUpdates({}, alpha), { preview: alpha });
  assert.deepEqual(selectChannelUpdates({ preview: alpha }, stable), { stable, preview: stable });
  assert.deepEqual(selectChannelUpdates({ stable, preview: future }, alpha), {});
  assert.deepEqual(selectChannelUpdates({ preview: future }, stable), { stable });
  assert.deepEqual(selectChannelUpdates({ preview: alpha }, alpha), {});
  assert.throws(() => selectChannelUpdates({ preview: { version: 'broken' } }, alpha), /SemVer/);
});

test('更新清单拒绝空签名、路径注入和非版本安装包名', () => {
  const input = { repository: 'Mowonhua/foldmark', version: '0.1.0', installerName: 'Foldmark_0.1.0_x64-setup.exe', signature: 'signed', notes: '', publishedAt: '2026-09-12T00:00:00Z' };
  assert.throws(() => createUpdateManifest({ ...input, signature: ' ' }), /签名/);
  assert.throws(() => createUpdateManifest({ ...input, repository: '../other' }), /仓库/);
  assert.throws(() => createUpdateManifest({ ...input, installerName: '../installer.exe' }), /安装包/);
});
