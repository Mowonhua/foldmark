/**
 * 文件职责：定义发布版本、更新清单及频道晋升的纯校验规则。
 * 定义范围：版本一致性、SemVer 顺序、Windows 发布资源和频道更新决策。
 */
import { createHash } from 'node:crypto';

// ==================== 内部版本解析 ====================

/** 将完整 SemVer 拆为排序字段；数值标识符保留字符串，避免超出 Number 精度。 */
function parseVersion(version) {
  const match = typeof version === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version);
  if (!match) throw new Error(`非法 SemVer：${version}`);
  const prerelease = match[4]?.split('.') ?? [];
  if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) throw new Error(`非法 SemVer：${version}`);
  return { core: match.slice(1, 4), prerelease };
}

// ==================== 函数定义 ====================

/**
 * 函数职责：校验发布版本与可选 Git 标签完全一致。
 * 输入说明：versions 是各清单和锁文件的版本映射，tag 缺省时仅校验文件一致性。
 * 输出说明：返回版本和预发布标志；非法 SemVer、版本漂移或标签不符时抛错。
 * 实现思路：将 npm 版本作为一致性基准，再验证严格 SemVer 与标签。
 */
export function validateReleaseVersions(versions, tag) {
  const version = versions.npm;
  const parsed = parseVersion(version);
  for (const [name, actual] of Object.entries(versions)) {
    if (actual !== version) throw new Error(`版本不一致：${name} 为 ${actual}，应为 ${version}`);
  }
  if (tag !== undefined && tag !== `v${version}`) throw new Error(`发布标签 ${tag} 必须等于 v${version}`);
  return { version, prerelease: parsed.prerelease.length > 0 };
}

/**
 * 函数职责：按 SemVer 比较发布优先级。
 * 输入说明：两个完整版本，允许构建元数据；数值预发布标识符不得有前导零。
 * 输出说明：返回负数、零或正数；构建元数据不参与排序，非法版本抛错。
 * 实现思路：依次比较主次修订版本和预发布标识符，正式版高于同版本预发布。
 */
export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return BigInt(a.core[index]) > BigInt(b.core[index]) ? 1 : -1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) return Math.sign(b.prerelease.length) - Math.sign(a.prerelease.length);
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

/**
 * 函数职责：生成 Tauri Windows x64 静态更新清单。
 * 输入说明：使用实际安装包名、签名正文、仓库、版本、说明及 RFC 3339 发布时间。
 * 输出说明：返回可序列化清单；下载地址只指向同仓库同版本 GitHub Release。
 * 实现思路：把产物与版本组成固定下载地址，并嵌入完整签名正文。
 */
export function createUpdateManifest({ repository, version, installerName, signature, notes, publishedAt }) {
  parseVersion(version);
  if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('GitHub 仓库名称无效');
  if (installerName !== `Foldmark_${version}_x64-setup.exe`) throw new Error('安装包文件名与版本不一致');
  if (typeof signature !== 'string' || signature.trim().length === 0) throw new Error('缺少更新签名正文');
  if (typeof notes !== 'string' || !Number.isFinite(Date.parse(publishedAt))) throw new Error('发布说明或日期无效');
  return {
    version,
    notes,
    pub_date: publishedAt,
    platforms: {
      'windows-x86_64': {
        signature: signature.trim(),
        url: `https://github.com/${repository}/releases/download/v${version}/${encodeURIComponent(installerName)}`,
      },
    },
  };
}

/**
 * 函数职责：验证下载到的发布资源能组成完整且一致的更新包。
 * 输入说明：files 为资源名到 Buffer 的映射，必须包含安装包、签名、latest.json 和 SHA256SUMS。
 * 输出说明：返回已验证清单；缺失、重名、摘要不符或清单指向其他版本时抛错。
 * 实现思路：先验证资源集合和摘要，再对照清单中的版本、下载地址及签名。
 */
export function verifyReleaseFiles(files, repository, version) {
  const installerName = `Foldmark_${version}_x64-setup.exe`;
  const names = [installerName, `${installerName}.sig`, 'latest.json'];
  if (files.size !== 4 || [...names, 'SHA256SUMS'].some((name) => !files.get(name)?.length)) throw new Error('发布资源缺失或包含意外文件');
  const rows = files.get('SHA256SUMS').toString('utf8').trim().split(/\r?\n/);
  if (rows.length !== names.length) throw new Error('资源摘要数量不正确');
  const checksums = new Map(rows.map((row) => {
    const match = /^([a-f0-9]{64}) {2}([^/\\]+)$/.exec(row);
    if (!match) throw new Error('资源摘要格式不正确');
    return [match[2], match[1]];
  }));
  for (const name of names) {
    if (checksums.get(name) !== createHash('sha256').update(files.get(name)).digest('hex')) throw new Error(`资源摘要不匹配：${name}`);
  }
  const manifest = JSON.parse(files.get('latest.json').toString('utf8'));
  if (manifest.version !== version) throw new Error('更新清单版本与标签不一致');
  const expected = createUpdateManifest({ repository, version, installerName, signature: files.get(`${installerName}.sig`).toString('utf8'), notes: manifest.notes, publishedAt: manifest.pub_date });
  if (Object.keys(manifest.platforms ?? {}).length !== 1 || manifest.platforms?.['windows-x86_64']?.url !== expected.platforms['windows-x86_64'].url) throw new Error('更新清单下载地址与发布资源不一致');
  if (manifest.platforms['windows-x86_64'].signature !== expected.platforms['windows-x86_64'].signature) throw new Error('更新清单签名与发布资源不一致');
  return manifest;
}

/**
 * 函数职责：决定已验证的新版本可以更新哪些频道。
 * 输入说明：current 按 stable、preview 保存现有清单，空频道用 null；manifest 必须已经通过资源校验。
 * 输出说明：返回应更新的频道映射；相同或较低版本不修改，预发布不进入 stable。
 * 实现思路：对目标频道逐一比较 SemVer，仅提升更高版本，正式版同时参与两个频道。
 */
export function selectChannelUpdates(current, manifest) {
  const { prerelease } = validateReleaseVersions({ npm: manifest.version });
  const updates = {};
  for (const channel of prerelease ? ['preview'] : ['stable', 'preview']) {
    if (!current[channel] || compareVersions(manifest.version, current[channel].version) > 0) updates[channel] = manifest;
  }
  return updates;
}
