/**
 * 文件职责：为本地和 CI 提供发布版本校验及资源整理命令。
 * 定义范围：读取项目清单、定位 NSIS 产物、生成更新清单与 SHA256SUMS。
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createUpdateManifest, validateReleaseVersions, verifyReleaseFiles } from './release-policy.mjs';

// ==================== 函数定义 ====================

/**
 * 函数职责：读取仓库中的发布版本并验证一致性。
 * 输入说明：root 是仓库目录，tag 是可选发布标签。
 * 输出说明：返回有效版本和预发布标志；任一清单或锁文件不一致时失败。
 * 实现思路：读取 npm、Tauri 和 Cargo 的版本及锁文件，交由纯规则校验。
 */
export async function readReleaseVersion(root, tag) {
  const [npmText, npmLockText, tauriText, cargoText, cargoLockText] = await Promise.all(
    ['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock'].map((name) => readFile(join(root, name), 'utf8')),
  );
  const npmLock = JSON.parse(npmLockText);
  const cargoPackage = cargoText.split('[package]')[1]?.split(/\r?\n\[/)[0];
  const cargoLockPackage = cargoLockText.split('[[package]]').find((block) => /^name\s*=\s*"foldmark"\s*$/m.test(block));
  return validateReleaseVersions({
    npm: JSON.parse(npmText).version,
    'package-lock.json': npmLock.version,
    'package-lock.json packages': npmLock.packages?.['']?.version,
    'tauri.conf.json': JSON.parse(tauriText).version,
    'Cargo.toml': cargoPackage?.match(/^version\s*=\s*"([^"]+)"/m)?.[1],
    'Cargo.lock': cargoLockPackage?.match(/^version\s*=\s*"([^"]+)"/m)?.[1],
  }, tag);
}

/**
 * 函数职责：将签名后的 Windows x64 NSIS 产物整理为完整发布资源。
 * 输入说明：root 指向仓库，repository 和 tag 标识 GitHub 发布；output 是独立输出目录。
 * 输出说明：写入安装包、签名、latest.json、SHA256SUMS，并返回输出目录；不执行远端操作。
 * 实现思路：定位唯一版本安装包，读取签名与版本说明，生成清单后对全部文件计算摘要并自校验。
 */
export async function prepareRelease({ root, repository, tag, output }) {
  const { version } = await readReleaseVersion(root, tag);
  const installerName = `Foldmark_${version}_x64-setup.exe`;
  const bundle = join(root, 'src-tauri/target/release/bundle/nsis');
  const [installer, signature, notes] = await Promise.all([
    readFile(join(bundle, installerName)),
    readFile(join(bundle, `${installerName}.sig`)),
    readFile(join(root, `docs/releases/${tag}.md`), 'utf8'),
  ]);
  const manifest = createUpdateManifest({ repository, version, installerName, signature: signature.toString('utf8'), notes, publishedAt: new Date().toISOString() });
  const files = new Map([
    [installerName, installer],
    [`${installerName}.sig`, signature],
    ['latest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)],
  ]);
  const sums = [...files].map(([name, bytes]) => `${createHash('sha256').update(bytes).digest('hex')}  ${name}`).join('\n');
  files.set('SHA256SUMS', Buffer.from(`${sums}\n`));
  verifyReleaseFiles(files, repository, version);
  await mkdir(output, { recursive: true });
  // 输出目录只属于本次资源包，残留其他版本文件时失败，避免上传旧安装包。
  if ((await readdir(output)).some((name) => !files.has(name))) throw new Error('发布输出目录包含其他文件，请选择独立空目录');
  await Promise.all([...files].map(([name, bytes]) => writeFile(join(output, name), bytes)));
  return output;
}

// ==================== 命令行入口 ====================

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined] = process.argv.slice(2);
    if (command === 'validate') {
      const info = await readReleaseVersion(process.cwd(), tag);
      console.log(`发布版本：${info.version}；预发布：${info.prerelease}`);
      if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `version=${info.version}\nprerelease=${info.prerelease}\n`);
    } else if (command === 'prepare') {
      if (!process.env.GITHUB_REPOSITORY || !process.env.RELEASE_DIR || !tag) throw new Error('prepare 需要 GITHUB_REPOSITORY、RELEASE_DIR 和版本标签');
      console.log(await prepareRelease({ root: process.cwd(), repository: process.env.GITHUB_REPOSITORY, tag, output: resolve(process.env.RELEASE_DIR) }));
    } else {
      throw new Error('用法：node scripts/release.mjs validate [v版本] | prepare [v版本]');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
