/**
 * 文件职责：为发布测试构造带真实 SHA-256 摘要的内存资源包。
 * 定义范围：仅用于测试的 Windows 安装包字节、签名占位和更新清单。
 */
import { createHash } from 'node:crypto';
import { createUpdateManifest } from './release-policy.mjs';

/** 生成指定版本的完整资源集合；安装包和签名为测试字节，不可作为实际安装产物。 */
export function releaseFixture(version = '0.1.0-alpha.1') {
  const repository = 'Mowonhua/foldmark';
  const installerName = `Foldmark_${version}_x64-setup.exe`;
  const signature = Buffer.from('untrusted comment: signature from minisign secret key\nRWQtest\n').toString('base64');
  const manifest = createUpdateManifest({ repository, version, installerName, signature, notes: '发布说明', publishedAt: '2026-09-12T00:00:00Z' });
  const files = new Map([
    [installerName, Buffer.from('test installer bytes')],
    [`${installerName}.sig`, Buffer.from(signature)],
    ['latest.json', Buffer.from(JSON.stringify(manifest))],
  ]);
  const sums = [...files].map(([name, bytes]) => `${createHash('sha256').update(bytes).digest('hex')}  ${name}`).join('\n');
  files.set('SHA256SUMS', Buffer.from(`${sums}\n`));
  return { repository, version, manifest, files, installerName };
}
