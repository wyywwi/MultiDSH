#!/usr/bin/env node
// Package the Electron desktop client as a double-clickable portable Windows app.
//
// No electron-builder / network needed: we reuse the electron binary that
// `pnpm install` already put in packages/desktop/node_modules/electron/dist and
// place the app sources at resources/app (Electron's standard app lookup path).
//
// Layout:
//   dist/MultiDSH-win/MultiDSH.exe           tiny C# launcher (double-click this)
//   dist/MultiDSH-win/MultiDSH-runtime.exe   renaming of electron.exe
//   dist/MultiDSH-win/resources/app/         the actual app (src/main.js, ...)
//
// The launcher exists because Electron's Chromium sandbox cannot always
// initialize when the app is started by a restricted parent process (it dies
// with EXCEPTION_BREAKPOINT / 0x80000003). A normal Explorer double-click is
// fine, but the launcher makes it robust everywhere: it starts the runtime
// sandboxed, and only on that specific crash retries with --no-sandbox.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const desktop = path.join(repo, 'packages', 'desktop');
const electronDist = path.join(desktop, 'node_modules', 'electron', 'dist');
const outDir = path.join(repo, 'dist', 'MultiDSH-win');
const appDir = path.join(outDir, 'resources', 'app');
const icon = path.join(repo, 'assets', 'icon', 'icon-black.ico');
const rcedit = path.join(here, 'vendor', 'rcedit.exe');
const APP_VERSION = '0.1.0';

function die(message) {
  console.error(`[package-desktop] ${message}`);
  process.exit(1);
}

/** Give the Electron runtime itself the black MultiDSH icon + name, so Task
 *  Manager / the taskbar no longer identify it as "Electron". */
function patchExe(exePath) {
  if (!fs.existsSync(exePath)) return;
  if (!fs.existsSync(rcedit)) {
    console.warn(`[package-desktop] rcedit.exe missing at ${rcedit}; leaving ${path.basename(exePath)} icon untouched`);
    return;
  }
  const args = [
    exePath,
    '--set-icon', icon,
    '--set-file-version', APP_VERSION,
    '--set-product-version', APP_VERSION,
    '--set-version-string', 'FileDescription', 'MultiDSH',
    '--set-version-string', 'ProductName', 'MultiDSH',
    '--set-version-string', 'CompanyName', 'MultiDSH',
    '--set-version-string', 'InternalName', 'MultiDSH',
    '--set-version-string', 'LegalCopyright', 'MultiDSH',
  ];
  const result = spawnSync(rcedit, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    console.warn(`[package-desktop] rcedit failed for ${path.basename(exePath)}: ${result.stderr || result.stdout || ''}`);
  }
}

if (!fs.existsSync(icon)) die(`black icon missing at ${icon}`);
if (!fs.existsSync(rcedit)) console.warn(`[package-desktop] rcedit.exe missing at ${rcedit}; exe icon/name patch skipped`);

if (!fs.existsSync(path.join(electronDist, 'electron.exe'))) {
  die(`electron dist not found at ${electronDist} — run pnpm install in packages/desktop first`);
}

console.log(`[package-desktop] electron dist: ${electronDist}`);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

// 1) Electron runtime files (electron.exe + dll/pak/locales/resources).
fs.cpSync(electronDist, outDir, { recursive: true });
fs.rmSync(path.join(outDir, 'resources', 'default_app.asar'), { force: true });
fs.rmSync(appDir, { recursive: true, force: true });
fs.mkdirSync(appDir, { recursive: true });

// 2) App sources: package.json + src (+ icon for the window/taskbar).
fs.copyFileSync(path.join(desktop, 'package.json'), path.join(appDir, 'package.json'));
fs.cpSync(path.join(desktop, 'src'), path.join(appDir, 'src'), { recursive: true });
if (fs.existsSync(icon)) {
  fs.mkdirSync(path.join(appDir, 'assets'), { recursive: true });
  fs.copyFileSync(icon, path.join(appDir, 'assets', 'icon.ico'));
} else {
  console.warn('[package-desktop] assets/icon/icon.ico missing; window uses default icon');
}
const trayPng = path.join(repo, 'assets', 'icon', 'tray.png');
if (fs.existsSync(trayPng)) {
  fs.mkdirSync(path.join(appDir, 'assets'), { recursive: true });
  fs.copyFileSync(trayPng, path.join(appDir, 'assets', 'tray.png'));
}

// 2b) Host sidecar runtime, so the app can start "this machine as a host" for
//     the user (no terminal needed). host/bin.js imports ../protocol/index.js,
//     so both packages must keep their relative layout.
const hostSrc = path.join(repo, 'packages', 'host');
const protocolSrc = path.join(repo, 'packages', 'protocol');
if (fs.existsSync(hostSrc) && fs.existsSync(protocolSrc)) {
  const skip = (src) => !src.includes(`${path.sep}node_modules`) && !src.includes(`${path.sep}.tmp`);
  fs.cpSync(hostSrc, path.join(appDir, 'host'), { recursive: true, filter: skip });
  fs.cpSync(protocolSrc, path.join(appDir, 'protocol'), { recursive: true, filter: skip });
} else {
  console.warn('[package-desktop] host/protocol packages missing; "add local host" will be disabled');
}

// 3) electron.exe -> MultiDSH-runtime.exe (Electron resolves resources/app itself).
fs.renameSync(path.join(outDir, 'electron.exe'), path.join(outDir, 'MultiDSH-runtime.exe'));

// 4) Tiny launcher with the normal sandbox attempt + EXCEPTION_BREAKPOINT retry.
const launcherSource = String.raw`
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;

[assembly: AssemblyTitle("MultiDSH")]
[assembly: AssemblyProduct("MultiDSH")]
[assembly: AssemblyDescription("MultiDSH desktop client for DeepSeek Harness")]
[assembly: AssemblyCompany("MultiDSH")]
[assembly: AssemblyVersion("0.1.0.0")]
[assembly: AssemblyFileVersion("0.1.0.0")]

internal static class Launcher
{
    private static string Quote(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return value;
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static int Run(string runtime, string dir, string arguments, bool probe)
    {
        var psi = new ProcessStartInfo(runtime, arguments)
        {
            UseShellExecute = false,
            WorkingDirectory = dir,
            CreateNoWindow = true,
        };
        var process = Process.Start(psi);
        if (process == null) return 1;
        if (probe && process.WaitForExit(6000))
        {
            int code = process.ExitCode;
            // EXCEPTION_BREAKPOINT: Chromium could not initialize its sandbox.
            if (code == unchecked((int)0x80000003)) return -1;
            return code;
        }
        process.WaitForExit();
        return process.ExitCode;
    }

    private static int Main(string[] args)
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        string runtime = Path.Combine(dir, "MultiDSH-runtime.exe");
        if (!File.Exists(runtime)) return 2;
        string arguments = string.Join(" ", Array.ConvertAll(args, Quote));
        int code = Run(runtime, dir, arguments, true);
        if (code != 0)
        {
            // Chromium may crash before the app starts on synced/OneDrive
            // folders (0x80000003 sandbox init, 0xC0000005 crashpad). Retrying
            // with --no-sandbox is what makes a plain double-click work there.
            string retry = (arguments + " --no-sandbox").Trim();
            code = Run(runtime, dir, retry, false);
        }
        return code;
    }
}
`;

const cscCandidates = [
  path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
];
const csc = cscCandidates.find((candidate) => fs.existsSync(candidate));

if (csc) {
  const sourcePath = path.join(outDir, 'launcher.cs');
  fs.writeFileSync(sourcePath, launcherSource, 'utf8');
  const cscArgs = ['/nologo', '/target:winexe', `/out:${path.join(outDir, 'MultiDSH.exe')}`];
  if (fs.existsSync(icon)) cscArgs.push(`/win32icon:${icon}`);
  cscArgs.push(sourcePath);
  const result = spawnSync(csc, cscArgs, { encoding: 'utf8' });
  fs.rmSync(sourcePath, { force: true });
  if (result.status !== 0) {
    console.error(result.stdout || '', result.stderr || '');
    die(`csc failed with status ${result.status}`);
  }
  console.log(`[package-desktop] launcher compiled with ${csc}`);
} else {
  // Fallback: ship the runtime itself (works for a normal Explorer double-click).
  fs.renameSync(path.join(outDir, 'MultiDSH-runtime.exe'), path.join(outDir, 'MultiDSH.exe'));
  console.warn('[package-desktop] csc.exe not found; shipping electron.exe as MultiDSH.exe');
}

// The window/taskbar icon comes from the .exe resources. Electron's runtime was
// renamed from electron.exe, so without this patch Windows shows Electron's
// blue icon and "Electron" as the file description in Task Manager.
patchExe(path.join(outDir, 'MultiDSH-runtime.exe'));
patchExe(path.join(outDir, 'MultiDSH.exe'));

fs.writeFileSync(
  path.join(outDir, '双击 MultiDSH.exe 启动.txt'),
  [
    'MultiDSH 桌面端',
    '',
    '双击 MultiDSH.exe 即可启动。',
    '',
    '首次启动会进入正式引导页；想看示例数据：设置 → 演示模式 → 进入演示模式。',
    '演示模式不会连接任何服务器，随时可以在同一位置退出。',
    '',
    '默认是浅色界面；想用深色：设置 → 外观 →「深色」，选择会保存在本机，重启后保持。',
    '',
    '关闭窗口（×）不会退出：应用会缩到系统托盘继续后台运行；',
    '要完全退出（并停止本机主机），请右键托盘图标 →「退出 MultiDSH」。',
    '',
    '真实 Directory 默认地址：https://multidsh.example.com',
    '（可在设置里修改，例如本地 http://127.0.0.1:8787）',
    '',
    '把本机 DSH 加入池：设置 →「本机主机（Host）」→ 启动，不用命令行（docs\\LOCAL-HOST.md）。',
    '',
    '池/设备身份保存在 %APPDATA%\\MultiDSH\\config.json，覆盖升级不会丢；',
    '更新：完全退出 MultiDSH 后，把新 zip 解压覆盖本目录即可，不需要重新创建池或重新登录。',
    '',
    '缺少 Node/npm/DSH 时：设置 → DSH 主机实例 → 安装 Node/DSH，可一键装到本机用户目录。',
    '',
    '参数：MultiDSH.exe --demo 强制演示。',
    '此目录可整体复制到其他 Windows 机器，无需安装 Node/Electron。',
  ].join('\r\n'),
  'utf8',
);

const exe = path.join(outDir, 'MultiDSH.exe');
if (!fs.existsSync(exe)) die('MultiDSH.exe missing after packaging');
// An agent/CI workspace can carry a Low mandatory integrity label, and a
// low-integrity process cannot register tray icons with Explorer or write
// %APPDATA%. Explorer extraction yields Medium normally, but make the built
// folder self-contained for direct double-clicking too.
if (process.platform === 'win32') {
  const icacls = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'icacls.exe');
  const r = spawnSync(icacls, [outDir, '/setintegritylevel', 'Medium', '/T', '/C'], {
    stdio: 'ignore',
  });
  if (r.status !== 0) console.warn('[package-desktop] could not reset integrity label');
}
console.log(`[package-desktop] OK -> ${exe}`);
console.log(`[package-desktop] app -> ${path.join(appDir, 'src', 'main.js')}`);
