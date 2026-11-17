#!/usr/bin/env node
/**
 * build-from-upstream.js — Patch upstream Codex and repackage
 *
 * For macOS and Windows: no forge needed.
 * Takes the upstream app, patches ASAR in-place, and outputs distributable.
 * macOS and Windows keep the upstream Codex CLI so the app-server protocol stays
 * aligned with the bundled code-mode host and local tool runtimes.
 *
 * Usage:
 *   node scripts/build-from-upstream.js --platform mac-arm64
 *   node scripts/build-from-upstream.js --platform mac-x64
 *   node scripts/build-from-upstream.js --platform win
 */
const fs = require("fs");
const path = require("path");
const { execSync, execFileSync } = require("child_process");
const { getCodexBinarySource } = require("./codex-binary-policy");
const { resolveUpstreamCodex } = require("./codex-resources");
const { validateWindowsPackage } = require("./sync-upstream");
const { assertMatchingWindowsRuntime } = require("./windows-runtime-compatibility");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(PROJECT_ROOT, "src");
// CODEX_OUT_DIR 用于输出目录被其他进程锁定时（如 IDE 缓存 asar 句柄）换新目录构建
const OUT_DIR = process.env.CODEX_OUT_DIR
  ? path.resolve(PROJECT_ROOT, process.env.CODEX_OUT_DIR)
  : path.join(PROJECT_ROOT, "out");

// ─── Helpers ────────────────────────────────────────────────────

function clearDir(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
}

function copyRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  let count = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) { count += copyRecursive(s, d); }
    else if (e.isSymbolicLink()) {
      const target = fs.readlinkSync(s);
      try { fs.symlinkSync(target, d); } catch {}
      count++;
    } else {
      fs.copyFileSync(s, d);
      count++;
    }
  }
  return count;
}

function findPath(dir, predicate) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (predicate(e, full)) return full;
    if (e.isDirectory()) {
      const found = findPath(full, predicate);
      if (found) return found;
    }
  }
  return null;
}

function findAppAncestor(startPath, boundaryDir) {
  const boundary = path.resolve(boundaryDir);
  let current = path.resolve(startPath);
  while (current.startsWith(boundary)) {
    if (path.basename(current).toLowerCase().endsWith(".app")) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function findMacAppBundle(extractDir) {
  // 上游安装包偶尔会调整 bundle 名称，不能只匹配 Codex.app。
  const codexApp = findPath(extractDir, (e) => e.isDirectory() && e.name === "Codex.app");
  if (codexApp) return codexApp;

  const anyApp = findPath(extractDir, (e) => e.isDirectory() && e.name.toLowerCase().endsWith(".app"));
  if (anyApp) return anyApp;

  const asarPath = findPath(extractDir, (e) => e.isFile() && e.name === "app.asar");
  return asarPath ? findAppAncestor(path.dirname(asarPath), extractDir) : null;
}

function clearExistingAsarUnpacked(asarPath) {
  const unpackedPath = `${asarPath}.unpacked`;
  if (fs.existsSync(unpackedPath)) {
    fs.rmSync(unpackedPath, { recursive: true, force: true });
  }
}

/**
 * plugins 与 cua_node 位于 app.asar 外，补丁脚本修改的是 src/<platform>
 * 中的规范副本。上游直打包流程先复制安装包缓存，因此必须再覆盖这两个目录，
 * 否则外部运行时补丁不会进入最终产物。
 */
function overlayPatchedExternalResources(platformDir, resourcesDir) {
  const resourceNames = ["plugins", "cua_node"];
  let copied = 0;

  for (const name of resourceNames) {
    const source = path.join(platformDir, name);
    if (!fs.existsSync(source)) continue;
    const destination = path.join(resourcesDir, name);
    copied += copyRecursive(source, destination);
  }

  console.log(`   [overlay] patched external resources (${copied} files)`);
  return copied;
}

function isOwlRuntime(appDir) {
  return (
    fs.existsSync(path.join(appDir, "owl-shell-runtime.json")) &&
    fs.existsSync(path.join(appDir, "resources", "owl-electron-app.json"))
  );
}

function assertWindowsPortableRuntime(asarDir) {
  const manifestPath = path.join(asarDir, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.codexWindowsAppContainedCore === "1") {
    throw new Error(
      "Windows portable build still requires an MSIX package identity. Run patch-all.js win first.",
    );
  }
  return manifest;
}

function ensureWindowsPortableLauncher(appDir) {
  if (!isOwlRuntime(appDir)) return null;

  const runtimePath = path.join(appDir, "ChatGPT.exe");
  const launcherPath = path.join(appDir, "Codex.exe");
  if (!fs.existsSync(runtimePath)) {
    throw new Error("Windows Owl runtime executable not found: ChatGPT.exe");
  }

  // MSIX 中的 Codex.exe 是依赖程序包身份的存根；便携包需直接启动 Owl runtime。
  fs.copyFileSync(runtimePath, launcherPath);
  console.log("   [launcher] Codex.exe -> portable Owl runtime");
  return launcherPath;
}

function asarCliPath() {
  return path.join(PROJECT_ROOT, "node_modules", "@electron", "asar", "bin", "asar.mjs");
}

function packAsar(asarDir, asarPath, extraArgs = []) {
  execFileSync(process.execPath, [asarCliPath(), "pack", asarDir, asarPath, ...extraArgs], {
    stdio: "pipe",
  });
}

function isRetryableHdiutilError(error) {
  const output = [error?.message, error?.stdout, error?.stderr]
    .filter(Boolean)
    .map(String)
    .join("\n");
  return /resource (?:temporarily unavailable|busy)/i.test(output);
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function createDmg(sourceDir, dmgPath, options = {}) {
  const {
    attempts = 3,
    retryDelayMs = 5000,
    run = execFileSync,
    wait = sleepSync,
    log = console.log,
  } = options;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      run("hdiutil", [
        "create",
        "-volname", "Codex",
        "-srcfolder", sourceDir,
        "-ov",
        "-format", "UDZO",
        dmgPath,
      ], { stdio: "pipe" });
      return;
    } catch (error) {
      if (attempt === attempts || !isRetryableHdiutilError(error)) throw error;

      // hdiutil 偶尔会留下不完整镜像，重试前必须清理。
      fs.rmSync(dmgPath, { force: true });
      const delay = retryDelayMs * attempt;
      log(`   [retry ${attempt}/${attempts - 1}] hdiutil resource busy; retrying in ${delay}ms`);
      wait(delay);
    }
  }
}

// ─── macOS build ────────────────────────────────────────────────

function buildMac(platform) {
  const platformDir = path.join(SRC_DIR, platform);
  const asarDir = path.join(platformDir, "_asar");

  if (!fs.existsSync(asarDir)) {
    console.error(`[x] ${platform}/_asar/ not found. Run sync-upstream first.`);
    process.exit(1);
  }

  // 1. Find the .app in the ZIP extract cache
  const tempDir = path.join(require("os").tmpdir(), "codex-sync");
  const variant = platform === "mac-arm64" ? "arm64" : "x64";
  const extractDir = path.join(tempDir, `${variant}-extract`);

  const appPath = fs.existsSync(extractDir) ? findMacAppBundle(extractDir) : null;

  if (!appPath) {
    const asarPath = fs.existsSync(extractDir)
      ? findPath(extractDir, (e) => e.isFile() && e.name === "app.asar")
      : null;
    console.error(`[x] macOS .app bundle not found in cache${asarPath ? ` (app.asar at ${asarPath})` : ""}. Run sync-upstream first.`);
    process.exit(1);
  }

  console.log(`   [source] ${appPath}`);

  // 2. Copy .app to output (ditto preserves symlinks + resource forks)
  const outAppDir = path.join(OUT_DIR, platform);
  clearDir(outAppDir);
  const outApp = path.join(outAppDir, "Codex.app");
  console.log("   [copy] Codex.app -> out/");
  execSync(`ditto "${appPath}" "${outApp}"`);

  const resourcesDir = path.join(outApp, "Contents", "Resources");

  // 外置插件与 CUA 运行时不在 ASAR 内，需显式带入补丁后的规范副本。
  overlayPatchedExternalResources(platformDir, resourcesDir);

  // 3. Repack patched ASAR
  const asarPath = path.join(resourcesDir, "app.asar");
  console.log("   [asar pack] _asar/ -> app.asar");
  clearExistingAsarUnpacked(asarPath);
  packAsar(asarDir, asarPath, [
    "--unpack-dir", "{node_modules/better-sqlite3,node_modules/node-pty}",
    "--unpack", "{**/*.node,**/node-pty/build/Release/*.exe}",
  ]);

  // 4. Update ASAR integrity hash in Info.plist
  const infoPlist = path.join(outApp, "Contents", "Info.plist");
  if (fs.existsSync(infoPlist)) {
    updateAsarIntegrity(asarPath, infoPlist);
  }

  // 5. Strip original signature + quarantine
  console.log("   [codesign] removing original signature");
  try { execSync(`codesign --remove-signature "${outApp}"`, { stdio: "pipe" }); } catch {}
  try { execSync(`xattr -rd com.apple.quarantine "${outApp}"`, { stdio: "pipe" }); } catch {}

  // 6. 保留与当前桌面端及 code-mode host 同包发布的 CLI，避免 IPC 协议漂移。
  keepUpstreamCodex(platform, resourcesDir, "codex");

  // 7. Ad-hoc re-sign (prevents "damaged app" Gatekeeper error)
  console.log("   [codesign] ad-hoc signing");
  try {
    execSync(`codesign --sign - --force --deep "${outApp}"`, { stdio: "pipe" });
    console.log("   [ok] ad-hoc signed");
  } catch (e) {
    console.log(`   [!] ad-hoc sign failed: ${e.message}`);
  }

  // 8. Create DMG
  const version = getVersion(asarDir);
  const dmgName = `Codex-${platform}-${version}.dmg`;
  const dmgPath = path.join(OUT_DIR, dmgName);
  console.log(`   [dmg] ${dmgName}`);
  createDmg(outAppDir, dmgPath);
  const sizeMB = (fs.statSync(dmgPath).size / 1048576).toFixed(1);
  console.log(`   [ok] ${dmgPath} (${sizeMB} MB)`);
}

// ─── Windows build ──────────────────────────────────────────────

function buildWin(platform) {
  const platformDir = path.join(SRC_DIR, platform);
  const asarDir = path.join(platformDir, "_asar");

  if (!fs.existsSync(asarDir)) {
    console.error(`[x] win/_asar/ not found. Run sync-upstream first.`);
    process.exit(1);
  }

  // Windows: use the MSIX extract cache
  const tempDir = path.join(require("os").tmpdir(), "codex-sync");
  const extractDir = path.join(tempDir, "win-extract");
  const appDir = path.join(extractDir, "app");

  if (!fs.existsSync(appDir)) {
    console.error(`[x] MSIX extract not found. Run sync-upstream first.`);
    process.exit(1);
  }

  if (isOwlRuntime(appDir)) {
    assertWindowsPortableRuntime(asarDir);
  }

  // 即使绕过同步步骤，也禁止将旧的 ARM64 缓存打包成 x64 产物。
  try {
    const identity = validateWindowsPackage(extractDir, {
      architecture: "x64",
    });
    console.log(`   [verify] MSIX ${identity.architecture}, version ${identity.version}`);
  } catch (e) {
    console.error(`[x] ${e.message}`);
    process.exit(1);
  }

  // Copy app/ to output
  // 在清理输出前校验整套版本，缓存被另一次同步覆盖时明确失败。
  const runtime = assertMatchingWindowsRuntime(platformDir, appDir);
  console.log(`   [verify] paired desktop ${runtime.version} (${runtime.build}), ${runtime.binaries.length} runtime binaries`);
  const outAppDir = path.join(OUT_DIR, "win");
  clearDir(outAppDir);
  const outApp = path.join(outAppDir, "Codex-win32-x64");
  console.log("   [copy] MSIX app/ -> out/");
  copyRecursive(appDir, outApp);

  const resourcesDir = path.join(outApp, "resources");

  // 外置插件与 CUA 运行时不在 ASAR 内，需显式带入补丁后的规范副本。
  overlayPatchedExternalResources(platformDir, resourcesDir);

  // Compute old ASAR header hash (before repack)
  const asarPath = path.join(resourcesDir, "app.asar");
  const oldHash = computeAsarHeaderHash(asarPath);
  console.log(`   [integrity] old hash: ${oldHash.slice(0, 16)}...`);

  // Repack patched ASAR
  console.log("   [asar pack] _asar/ -> app.asar");
  clearExistingAsarUnpacked(asarPath);
  packAsar(asarDir, asarPath, [
    "--unpack-dir", "{node_modules/better-sqlite3,node_modules/node-pty,node_modules/@worklouder}",
  ]);

  // Compute new hash and patch exe
  const newHash = computeAsarHeaderHash(asarPath);
  console.log(`   [integrity] new hash: ${newHash.slice(0, 16)}...`);

  if (oldHash !== newHash) {
    patchWindowsAsarIntegrity(outApp, oldHash, newHash);
  }

  ensureWindowsPortableLauncher(outApp);

  // 保留上游 Windows CLI，使 app-server、code-mode host 与本地工具运行时版本一致。
  keepUpstreamCodex(platform, resourcesDir, "codex.exe");

  // Create ZIP
  const version = getVersion(asarDir);
  const zipName = `Codex-win-x64-${version}.zip`;
  const zipPath = path.join(OUT_DIR, zipName);
  console.log(`   [zip] ${zipName}`);
  createZip(zipPath, outApp);

  const sizeMB = (fs.statSync(zipPath).size / 1048576).toFixed(1);
  console.log(`   [ok] ${zipPath} (${sizeMB} MB)`);
}

// ─── ASAR integrity ─────────────────────────────────────────────

function computeAsarHeaderHash(asarPath) {
  const crypto = require("crypto");
  const buf = fs.readFileSync(asarPath);
  const headerSize = buf.readUInt32LE(12);
  const header = buf.slice(16, 16 + headerSize);
  return crypto.createHash("sha256").update(header).digest("hex");
}

function patchExeHash(exePath, oldHash, newHash) {
  const buf = fs.readFileSync(exePath);
  const oldBuf = Buffer.from(oldHash, "ascii");
  const idx = buf.indexOf(oldBuf);
  if (idx < 0) {
    console.log("   [!] old hash not found in exe");
    return false;
  }
  Buffer.from(newHash, "ascii").copy(buf, idx);
  fs.writeFileSync(exePath, buf);
  console.log(`   [integrity] exe hash patched at offset ${idx}`);
  return true;
}

function patchWindowsAsarIntegrity(appDir, oldHash, newHash) {
  // 新版 Owl 把 Electron ASAR 哈希嵌入 ChatGPT.exe；旧版运行时则使用 Codex.exe。
  // 根据实际嵌入内容选择目标，避免仅凭运行时标记作出错误假设。
  const executableNames = isOwlRuntime(appDir)
    ? ["ChatGPT.exe", "Codex.exe"]
    : ["Codex.exe", "ChatGPT.exe"];
  const oldHashBytes = Buffer.from(oldHash, "ascii");

  for (const executableName of executableNames) {
    const exePath = path.join(appDir, executableName);
    if (!fs.existsSync(exePath)) continue;
    if (!fs.readFileSync(exePath).includes(oldHashBytes)) continue;

    patchExeHash(exePath, oldHash, newHash);
    console.log(`   [integrity] runtime executable: ${executableName}`);
    return exePath;
  }

  console.log("   [integrity] no embedded ASAR header hash found in Windows runtime executables");
  return null;
}

function updateAsarIntegrity(asarPath, infoPlistPath) {
  const newHash = computeAsarHeaderHash(asarPath);
  execSync(`plutil -replace ElectronAsarIntegrity.Resources/app\\\\.asar.hash -string "${newHash}" "${infoPlistPath}"`, { stdio: "pipe" });
  execSync(`plutil -replace ElectronAsarIntegrity.Resources/app\\\\.asar.algorithm -string "SHA256" "${infoPlistPath}"`, { stdio: "pipe" });

  // Verify
  const verify = execSync(`plutil -extract ElectronAsarIntegrity.Resources/app\\\\.asar.hash raw "${infoPlistPath}"`, { encoding: "utf-8" }).trim();
  if (verify === newHash) {
    console.log(`   [integrity] hash updated: ${newHash.slice(0, 16)}...`);
  } else {
    console.log(`   [!] integrity verify failed`);
  }
}

// ─── Shared ─────────────────────────────────────────────────────

function keepUpstreamCodex(platform, resourcesDir, binName) {
  if (getCodexBinarySource(platform) !== "upstream") {
    throw new Error(`Direct upstream packaging cannot use a replacement CLI for ${platform}`);
  }
  const codexPath = resolveUpstreamCodex(platform, resourcesDir, binName);
  console.log(`   [codex] keeping upstream ${path.relative(resourcesDir, codexPath)}`);
  return codexPath;
}

function createZip(zipPath, cwd) {
  const errors = [];

  for (const bin of ["7zz", "7z"]) {
    try {
      execFileSync(bin, ["a", "-tzip", "-mx=5", zipPath, "."], { cwd, stdio: "pipe" });
      return;
    } catch (e) {
      errors.push(`${bin}: ${e.message}`);
    }
  }

  if (process.platform === "win32") {
    try {
      execFileSync("powershell", [
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-Command",
        "& { param($src, $zip) " +
          "Add-Type -AssemblyName System.IO.Compression.FileSystem; " +
          "if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }; " +
          "[System.IO.Compression.ZipFile]::CreateFromDirectory($src, $zip, " +
          "[System.IO.Compression.CompressionLevel]::Optimal, $false) }",
        cwd,
        zipPath,
      ], { stdio: "pipe" });
      return;
    } catch (e) {
      errors.push(`powershell: ${e.message}`);
    }
  }

  for (const [bin, args] of [
    ["zip", ["-r", zipPath, "."]],
    ["tar", ["-a", "-cf", zipPath, "."]],
  ]) {
    try {
      execFileSync(bin, args, { cwd, stdio: "pipe" });
      return;
    } catch (e) {
      errors.push(`${bin}: ${e.message}`);
    }
  }

  throw new Error(`Failed to create ZIP: ${errors.join("; ")}`);
}

function getVersion(asarDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(asarDir, "package.json"), "utf-8"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

// ─── Main ───────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const platIdx = args.indexOf("--platform");
  const platform = platIdx !== -1 ? args[platIdx + 1] : null;

  if (!platform || !["mac-arm64", "mac-x64", "win"].includes(platform)) {
    console.error("[x] Usage: build-from-upstream.js --platform <mac-arm64|mac-x64|win>");
    process.exit(1);
  }

  console.log(`\n== Build from upstream: ${platform} ==\n`);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  if (platform.startsWith("mac")) {
    buildMac(platform);
  } else {
    buildWin(platform);
  }
}

if (require.main === module) main();

module.exports = {
  assertWindowsPortableRuntime,
  computeAsarHeaderHash,
  createDmg,
  ensureWindowsPortableLauncher,
  isOwlRuntime,
  isRetryableHdiutilError,
  keepUpstreamCodex,
  overlayPatchedExternalResources,
  patchExeHash,
  patchWindowsAsarIntegrity,
};
