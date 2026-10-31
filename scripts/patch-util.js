/**
 * Shared utilities for patch scripts.
 * Provides multi-platform bundle location and common helpers.
 */
const fs = require("fs");
const path = require("path");

const SRC_DIR = path.join(__dirname, "..", "src");
const PROJECT_ROOT = path.join(__dirname, "..");

/**
 * Locate bundles matching a filename pattern across platform directories.
 *
 * @param {object} opts
 * @param {"build"|"assets"} opts.dir - Subdirectory type:
 *   "build"  -> src/{plat}/.vite/build/
 *   "assets" -> src/{plat}/webview/assets/
 * @param {RegExp} opts.pattern - Filename regex (e.g. /^index-.*\.js$/)
 * @param {string} [opts.platform] - Restrict to a single platform
 * @returns {Array<{platform: string, path: string}>}
 */
function locateBundles({ dir, pattern, platform }) {
  const dirMap = {
    build: (plat) => path.join(SRC_DIR, plat, "_asar", ".vite", "build"),
    assets: (plat) => path.join(SRC_DIR, plat, "_asar", "webview", "assets"),
  };

  // Legacy fallback paths (flat src/ without _asar subdirs)
  const legacyMap = {
    build: path.join(SRC_DIR, ".vite", "build"),
    assets: path.join(SRC_DIR, "webview", "assets"),
  };

  const getDir = dirMap[dir];
  if (!getDir) throw new Error(`Unknown dir type: ${dir}`);

  const ALL_PLATFORMS = ["mac-arm64", "mac-x64", "win"];
  const platforms = platform
    ? [platform]
    : ALL_PLATFORMS.filter((p) => fs.existsSync(getDir(p)));

  // Legacy fallback
  if (platforms.length === 0) {
    const fallback = legacyMap[dir];
    if (fallback && fs.existsSync(fallback)) {
      const files = fs.readdirSync(fallback).filter((f) => pattern.test(f));
      if (files.length > 0) {
        // For build dir, prefer hashed file over plain
        const target =
          files.length > 1 ? files.find((f) => f !== "main.js") || files[0] : files[0];
        return [{ platform: "legacy", path: path.join(fallback, target) }];
      }
    }
    return [];
  }

  const results = [];
  for (const plat of platforms) {
    const d = getDir(plat);
    if (!fs.existsSync(d)) continue;

    const files = fs.readdirSync(d).filter((f) => pattern.test(f));
    if (files.length === 0) {
      console.warn(`  [!] ${plat}: no match for ${pattern}`);
      continue;
    }

    // For build dir with multiple matches, prefer hashed variant
    const target =
      files.length > 1 ? files.find((f) => f !== "main.js") || files[0] : files[0];

    results.push({ platform: plat, path: path.join(d, target) });
  }

  return results;
}

/**
 * Return path relative to project root.
 */
function relPath(absPath) {
  return path.relative(PROJECT_ROOT, absPath);
}

/**
 * 按内容查找全部主进程 chunk，兼容上游拆包及文件名变化。
 * 每个请求平台必须有目标；不能让某个平台的命中掩盖另一个平台的遗漏。
 * srcDir 允许回归测试使用独立目录，不接触本地已生成资源。
 */
function locateBuildTargets({ platform, test, label, srcDir = SRC_DIR }) {
  const buildDir = (name) => path.join(srcDir, name, "_asar", ".vite", "build");
  const platforms = platform
    ? [platform]
    : ["mac-arm64", "mac-x64", "win"].filter((name) => fs.existsSync(buildDir(name)));
  if (platforms.length === 0) throw new Error(`${label}: no generated platform sources found`);

  const targets = [];
  for (const current of platforms) {
    const directory = buildDir(current);
    if (!fs.existsSync(directory)) throw new Error(`${label}: build directory missing for ${current}`);
    const matches = fs.readdirSync(directory)
      .filter((name) => name.endsWith(".js"))
      .sort()
      .map((name) => ({ platform: current, path: path.join(directory, name) }))
      .filter((bundle) => test(fs.readFileSync(bundle.path, "utf8"), bundle.path));
    if (matches.length === 0) throw new Error(`${label}: no matching build chunks for ${current}`);
    targets.push(...matches);
  }
  return targets;
}

module.exports = { locateBundles, locateBuildTargets, relPath, SRC_DIR, PROJECT_ROOT };
