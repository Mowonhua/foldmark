/**
 * 文件职责：将已整理资源发布为 GitHub Release，并原子提升更新频道。
 * 定义范围：GitHub REST 请求、草稿资源验证、公开发布和 updates 分支提交。
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectChannelUpdates, validateReleaseVersions, verifyReleaseFiles } from './release-policy.mjs';

// ==================== GitHub 适配器 ====================

/** 将 GitHub 的 JSON、资源上传及二进制下载收敛到可注入的 HTTP 边界。仅显式允许的 404 代表不存在。 */
function githubApi(repository, token, request) {
  return async (path, { method = 'GET', body, binary = false, optional = false } = {}) => {
    const url = path.startsWith('https://') ? path : `https://api.github.com/repos/${repository}${path}`;
    const response = await request(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Foldmark-release',
        ...(body ? { 'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json' } : {}),
      },
      body: body ? Buffer.isBuffer(body) ? body : JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(120_000),
    });
    if (optional && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub ${method} ${new URL(url).pathname} 失败：HTTP ${response.status}`);
    if (response.status === 204) return null;
    return binary ? Buffer.from(await response.arrayBuffer()) : response.json();
  };
}

/** 下载实际上传的资源；拒绝重名和未上传完毕的资源，后续校验才能覆盖完整集合。 */
async function downloadReleaseFiles(api, release) {
  const files = new Map();
  for (const asset of release.assets) {
    if (files.has(asset.name) || asset.state !== 'uploaded') throw new Error('Release 资源重名或尚未上传完成');
    files.set(asset.name, await api(asset.url, { binary: true }));
  }
  return files;
}

/** 使用分支当前 commit 读取两个频道，并通过一次非强制 ref 更新提交晋升；并发写入会失败而不会覆盖其他发布。 */
async function promoteChannels(api, manifest) {
  const ref = await api('/git/ref/heads/updates', { optional: true });
  const commit = ref ? await api(`/git/commits/${ref.object.sha}`) : null;
  const current = {};
  if (ref) {
    for (const channel of ['stable', 'preview']) {
      const file = await api(`/contents/${channel}.json?ref=${ref.object.sha}`, { optional: true });
      if (file) current[channel] = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
    }
  }
  const updates = selectChannelUpdates(current, manifest);
  if (Object.keys(updates).length === 0) return [];
  const tree = await api('/git/trees', {
    method: 'POST',
    body: {
      ...(commit ? { base_tree: commit.tree.sha } : {}),
      tree: Object.entries(updates).map(([channel, value]) => ({ path: `${channel}.json`, mode: '100644', type: 'blob', content: `${JSON.stringify(value, null, 2)}\n` })),
    },
  });
  const next = await api('/git/commits', {
    method: 'POST',
    body: {
      message: `chore: 发布更新频道 v${manifest.version}\n\n- 将已验证的 v${manifest.version} 提升至 ${Object.keys(updates).join('、')} 频道`,
      tree: tree.sha,
      parents: ref ? [ref.object.sha] : [],
    },
  });
  if (ref) await api('/git/refs/heads/updates', { method: 'PATCH', body: { sha: next.sha, force: false } });
  if (!ref) await api('/git/refs', { method: 'POST', body: { ref: 'refs/heads/updates', sha: next.sha } });
  return Object.keys(updates);
}

// ==================== 函数定义 ====================

/**
 * 函数职责：发布完整的 GitHub Release，并在资源验证成功后提升更新频道。
 * 输入说明：repository、tag、directory 定位本地资源；token 必须具有 contents:write 权限；request 用于注入 HTTP 边界。
 * 输出说明：公开 Release 并更新 updates 分支；失败时抛错，公开版本不覆盖资源；重跑可以完成频道晋升。
 * 实现思路：先读取或创建草稿，上传资源并下载校验，公开后再次验证，再原子提交更高版本的频道清单。
 */
export async function publishRelease({ repository, tag, directory, token, request = fetch }) {
  if (!token) throw new Error('缺少 GITHUB_TOKEN');
  if (!tag?.startsWith('v')) throw new Error('发布标签必须以 v 开头');
  const { version, prerelease } = validateReleaseVersions({ npm: tag.slice(1) }, tag);
  const localFiles = new Map(await Promise.all((await readdir(directory)).map(async (name) => [name, await readFile(join(directory, name))])));
  const localManifest = verifyReleaseFiles(localFiles, repository, version);
  const api = githubApi(repository, token, request);
  let release = await api(`/releases/tags/${encodeURIComponent(tag)}`, { optional: true });
  if (!release) {
    release = await api('/releases', { method: 'POST', body: { tag_name: tag, name: `Foldmark ${tag}`, body: localManifest.notes, draft: true, prerelease, make_latest: 'false' } });
  }
  if (release.tag_name !== tag || release.prerelease !== prerelease) throw new Error('已有 Release 的标签或预发布状态与当前版本不一致');
  if (release.draft) {
    // 草稿重跑可替换尚未对外承诺的产物；公开 Release 必须始终使用首次发布的字节。
    for (const asset of release.assets) await api(`/releases/assets/${asset.id}`, { method: 'DELETE' });
    const uploadUrl = release.upload_url.replace(/\{.*$/, '');
    for (const [name, bytes] of localFiles) await api(`${uploadUrl}?name=${encodeURIComponent(name)}`, { method: 'POST', body: bytes });
    release = await api(`/releases/${release.id}`);
    verifyReleaseFiles(await downloadReleaseFiles(api, release), repository, version);
    release = await api(`/releases/${release.id}`, { method: 'PATCH', body: { draft: false, prerelease, make_latest: prerelease ? 'false' : 'legacy', body: localManifest.notes } });
  }
  // 频道只能引用已公开、下载后校验通过的资源；此处失败时保留 Release，重跑可继续晋升。
  const manifest = verifyReleaseFiles(await downloadReleaseFiles(api, release), repository, version);
  const channels = await promoteChannels(api, manifest);
  return { url: `https://github.com/${repository}/releases/tag/${tag}`, prerelease, channels };
}

// ==================== 命令行入口 ====================

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { GITHUB_REPOSITORY: repository, GITHUB_REF_NAME: tag, RELEASE_DIR: directory, GITHUB_TOKEN: token } = process.env;
    if (!repository || !tag || !directory) throw new Error('需要 GITHUB_REPOSITORY、GITHUB_REF_NAME 和 RELEASE_DIR');
    console.log(JSON.stringify(await publishRelease({ repository, tag, directory: resolve(directory), token }), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
