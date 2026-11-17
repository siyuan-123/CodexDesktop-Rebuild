const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

/** 分块读取大型 CLI，避免校验两个安装包时把整个二进制加载进内存。 */
function fileSha256(file) {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(file, "r");
  try {
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/**
 * 打包前核对补丁源与 MSIX 缓存，阻止新桌面 JS 混入旧 CLI/执行器。
 * JS 补丁可以改变清单中的便携模式等字段，版本与构建号必须来自同包。
 */
function assertMatchingWindowsRuntime(platformDir, cachedAppDir) {
  const source = JSON.parse(fs.readFileSync(path.join(platformDir, "_asar", "package.json"), "utf8"));
  const resources = path.join(cachedAppDir, "resources");
  const cached = JSON.parse(require("@electron/asar")
    .extractFile(path.join(resources, "app.asar"), "package.json").toString("utf8"));

  if (!source.version || !cached.version) {
    throw new Error("Windows 运行时清单缺少 version，无法确认配套版本");
  }
  for (const field of ["version", "codexBuildNumber"]) {
    if (String(source[field] ?? "") !== String(cached[field] ?? "")) {
      throw new Error(`Windows 运行时版本不匹配：${field} 补丁源=${source[field] ?? "缺失"}，MSIX 缓存=${cached[field] ?? "缺失"}。请重新同步同一个安装包。`);
    }
  }

  const names = [
    "codex.exe",
    "codex-code-mode-host.exe",
    "codex-command-runner.exe",
    "codex-windows-sandbox-service.exe",
    "codex-windows-sandbox-setup.exe",
  ];
  const binaries = [];
  for (const name of names) {
    const sourcePath = path.join(platformDir, name);
    const cachedPath = path.join(resources, name);
    const sourceExists = fs.existsSync(sourcePath);
    const cachedExists = fs.existsSync(cachedPath);
    // 旧版没有的辅助程序允许双边缺省；任意一侧存在时必须完整匹配。
    if (name !== "codex.exe" && !sourceExists && !cachedExists) continue;
    if (!sourceExists || !cachedExists) {
      throw new Error(`Windows 运行时缺少配套文件 ${name}：补丁源=${sourceExists}，MSIX 缓存=${cachedExists}`);
    }
    const sha256 = fileSha256(sourcePath);
    if (sha256 !== fileSha256(cachedPath)) {
      throw new Error(`Windows 运行时二进制不匹配：${name} 与 MSIX 缓存不同。请重新同步同一个安装包。`);
    }
    binaries.push({ name, sha256 });
  }
  return { version: source.version, build: String(source.codexBuildNumber ?? ""), binaries };
}

module.exports = { assertMatchingWindowsRuntime };
