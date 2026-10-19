/**
 * 文件职责：从 Taskrail 矢量源图导出 Windows、浏览器和 Android 使用的图标。
 * 定义范围：Tauri 图标导出命令及平台资源安装，不修改应用身份或签名配置。
 */
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const androidResources = join(root, 'src-tauri/gen/android/app/src/main/res');
const densities = [['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]];

/**
 * 函数职责：执行项目已安装的 Tauri 图标导出命令。
 * 输入说明：输入为图标源文件，输出为临时目录，sizes 为空时导出默认平台资源。
 * 输出说明：生成指定图标；命令失败时抛出错误并停止后续安装。
 * 实现思路：使用当前 Node.js 进程调用本地 CLI，显式传递参数，不经过 Shell。
 */
function runIconCommand(input, output, sizes = []) {
  const args = [join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'icon', input, '--output', output];
  for (const size of sizes) args.push('--png', String(size));
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Tauri 图标导出失败：${result.status ?? result.signal}`);
}

/**
 * 函数职责：从唯一矢量源图生成并替换受支持平台的全部应用标志。
 * 输入说明：读取 assets/brand/taskrail.svg，要求保留背景矩形标识及纯色路径。
 * 输出说明：更新桌面 PNG、ICO 和 Android 图标资源；结束时清理自身临时目录。
 * 实现思路：从源图派生前景、背景和圆形版本，分别导出后安装到现有资源位置。
 */
async function generateIcons() {
  const source = await readFile(join(root, 'assets/brand/taskrail.svg'), 'utf8');
  const background = source.match(/<rect id="background"[^>]*\/>/)?.[0];
  const paths = [...source.matchAll(/<path d="([^"]+)"\s*\/>/g)].map(match => match[1]);
  const backgroundColor = background?.match(/fill="([^"]+)"/)?.[1];
  const foregroundColor = source.match(/<g fill="([^"]+)">/)?.[1];
  if (!background || !backgroundColor || !foregroundColor || paths.length === 0) throw new Error('图标源图必须包含 background 矩形及同组纯色路径');
  const temporaryRoot = resolve(tmpdir());
  const temporary = await mkdtemp(join(temporaryRoot, 'taskrail-icons-'));
  try {
    await writeFile(join(temporary, 'default.svg'), source);
    // 在派生 SVG 中显式缩放，保证彩色与单色前景使用相同的遮罩安全边距。
    const foreground = source.replace(background, '').replace(`<g fill="${foregroundColor}">`, `<g fill="${foregroundColor}" transform="translate(512 512) scale(0.76) translate(-512 -512)">`);
    await writeFile(join(temporary, 'foreground.svg'), foreground);
    await writeFile(join(temporary, 'background.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="${backgroundColor}"/></svg>`);
    await writeFile(join(temporary, 'round.svg'), source.replace(background, `<circle cx="512" cy="512" r="448" fill="${backgroundColor}"/>`));
    const manifest = join(temporary, 'manifest.json');
    // 为系统圆形等遮罩保留边距；自适应前景不能按普通 PNG 的比例铺满画布。
    await writeFile(manifest, JSON.stringify({
      default: 'default.svg', bg_color: backgroundColor,
      android_bg: 'background.svg', android_fg: 'foreground.svg', android_fg_scale: 100,
      android_monochrome: 'foreground.svg',
    }));
    const platformOutput = join(temporary, 'platform');
    const squareOutput = join(temporary, 'square');
    const roundOutput = join(temporary, 'round');
    runIconCommand(manifest, platformOutput);
    // 旧版启动图标单独缩放完整源图，避免 CLI 合成时裁切 T 的横梁。
    const sizes = densities.map(([, size]) => size);
    runIconCommand(join(temporary, 'default.svg'), squareOutput, sizes);
    runIconCommand(join(temporary, 'round.svg'), roundOutput, sizes);
    for (const filename of ['icon.png', 'icon.ico']) {
      await copyFile(join(platformOutput, filename), join(root, 'src-tauri/icons', filename));
    }
    for (const [density, size] of densities) {
      const directory = join(androidResources, `mipmap-${density}`);
      await mkdir(directory, { recursive: true });
      for (const layer of ['foreground', 'background', 'monochrome']) {
        const filename = `ic_launcher_${layer}.png`;
        await copyFile(join(platformOutput, 'android', `mipmap-${density}`, filename), join(directory, filename));
      }
      await copyFile(join(squareOutput, `${size}x${size}.png`), join(directory, 'ic_launcher.png'));
      await copyFile(join(roundOutput, `${size}x${size}.png`), join(directory, 'ic_launcher_round.png'));
    }
    await copyFile(join(platformOutput, 'android/mipmap-anydpi-v26/ic_launcher.xml'), join(androidResources, 'mipmap-anydpi-v26/ic_launcher.xml'));
    // 保留模板资源名称供原生构建引用，但同时替换备用矢量，避免旧模板标志残留。
    const vector = `<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="108dp" android:height="108dp" android:viewportWidth="1024" android:viewportHeight="1024">\n`;
    await writeFile(join(androidResources, 'drawable-v24/ic_launcher_foreground.xml'), vector + '  <group android:pivotX="512" android:pivotY="512" android:scaleX="0.76" android:scaleY="0.76">\n' + paths.map(path => `    <path android:fillColor="${foregroundColor}" android:pathData="${path}"/>`).join('\n') + '\n  </group>\n</vector>\n');
    await writeFile(join(androidResources, 'drawable/ic_launcher_background.xml'), vector + `  <path android:fillColor="${backgroundColor}" android:pathData="M0 0H1024V1024H0Z"/>\n</vector>\n`);
    await writeFile(join(androidResources, 'values/ic_launcher_background.xml'), `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n  <color name="ic_launcher_background">${backgroundColor}</color>\n</resources>\n`);
    console.log('Windows、浏览器与 Android 图标已从 assets/brand/taskrail.svg 更新。');
  } finally {
    // 只递归删除本次 mkdtemp 创建的直属目录；路径检查必须先于删除。
    if (dirname(temporary) !== temporaryRoot || !basename(temporary).startsWith('taskrail-icons-')) throw new Error('临时图标目录超出清理范围');
    await rm(temporary, { recursive: true, force: true });
  }
}

await generateIcons();
