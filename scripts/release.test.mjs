/**
 * 文件职责：验证发布 CLI 在真实临时目录中读取清单并整理签名资源。
 * 定义范围：多清单版本一致性、缺少说明和完整资源包的 IO 验收。
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareRelease, readReleaseVersion } from './release.mjs';
import { verifyReleaseFiles } from './release-policy.mjs';

test('发布整理产生可校验的四项资源，清单与 lockfile 漂移立即失败', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'foldmark-release-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const version = '0.1.0-alpha.1';
  const bundle = join(root, 'src-tauri/target/release/bundle/nsis');
  await mkdir(bundle, { recursive: true });
  await mkdir(join(root, 'docs/releases'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ version }));
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ version, packages: { '': { version } } }));
  await writeFile(join(root, 'src-tauri/tauri.conf.json'), JSON.stringify({ version }));
  await writeFile(join(root, 'src-tauri/Cargo.toml'), `[package]\nname = "foldmark"\nversion = "${version}"\n`);
  await writeFile(join(root, 'src-tauri/Cargo.lock'), `version = 4\n\n[[package]]\nname = "dependency"\nversion = "9.0.0"\n\n[[package]]\nname = "foldmark"\nversion = "${version}"\n`);
  await writeFile(join(root, `docs/releases/v${version}.md`), '首个预发布版本。\n');
  await writeFile(join(bundle, `Foldmark_${version}_x64-setup.exe`), 'installer');
  await writeFile(join(bundle, `Foldmark_${version}_x64-setup.exe.sig`), 'signature');
  assert.equal((await readReleaseVersion(root, `v${version}`)).version, version);
  const output = join(root, 'output');
  await prepareRelease({ root, output, repository: 'Mowonhua/foldmark', tag: `v${version}` });
  const files = new Map(await Promise.all((await readdir(output)).map(async (name) => [name, await readFile(join(output, name))])));
  assert.equal(verifyReleaseFiles(files, 'Mowonhua/foldmark', version).notes, '首个预发布版本。\n');
  await writeFile(join(root, 'src-tauri/Cargo.lock'), '[[package]]\nname = "foldmark"\nversion = "0.1.0"\n');
  await assert.rejects(readReleaseVersion(root), /Cargo.lock/);
});
