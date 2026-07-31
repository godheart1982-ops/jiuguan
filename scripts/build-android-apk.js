const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const projectRoot = path.resolve(__dirname, '..');
const androidDir = path.join(projectRoot, 'android');
const appBuildGradle = path.join(androidDir, 'app', 'build.gradle');

if (!fs.existsSync(androidDir)) {
  console.error('Android project not found at project root. Run: npx cap add android');
  process.exit(1);
}

/**
 * 每次打包自动升版：versionCode +1，versionName 末段 +1（如 2.1.57 → 2.1.58）
 * 跳过：环境变量 SKIP_VERSION_BUMP=1 或参数 --no-bump
 */
function bumpAndroidVersion() {
  const skip =
    process.env.SKIP_VERSION_BUMP === '1' ||
    process.argv.includes('--no-bump');
  if (skip) {
    console.log('Skip version bump (SKIP_VERSION_BUMP or --no-bump)');
    return null;
  }
  if (!fs.existsSync(appBuildGradle)) {
    console.warn('app/build.gradle not found, skip version bump');
    return null;
  }
  let text = fs.readFileSync(appBuildGradle, 'utf8');
  const codeMatch = text.match(/versionCode\s+(\d+)/);
  const nameMatch = text.match(/versionName\s+"([^"]+)"/);
  if (!codeMatch || !nameMatch) {
    console.warn('Could not parse versionCode/versionName, skip bump');
    return null;
  }
  const oldCode = parseInt(codeMatch[1], 10);
  const oldName = nameMatch[1];
  const newCode = oldCode + 1;
  const parts = oldName.split('.');
  if (parts.length >= 1 && /^\d+$/.test(parts[parts.length - 1])) {
    parts[parts.length - 1] = String(parseInt(parts[parts.length - 1], 10) + 1);
  } else {
    parts.push('1');
  }
  const newName = parts.join('.');
  text = text
    .replace(/versionCode\s+\d+/, `versionCode ${newCode}`)
    .replace(/versionName\s+"[^"]+"/, `versionName "${newName}"`);
  fs.writeFileSync(appBuildGradle, text, 'utf8');

  // 同步文档里的当前版本（若存在）
  for (const rel of ['README.md', 'BUILD.md']) {
    const p = path.join(projectRoot, rel);
    if (!fs.existsSync(p)) continue;
    let doc = fs.readFileSync(p, 'utf8');
    let next = doc;
    if (doc.includes(oldName)) {
      next = next.split(oldName).join(newName);
    }
    // BUILD.md 示例里的 versionCode
    next = next.replace(
      new RegExp(`versionCode\\s+${oldCode}\\b`),
      `versionCode ${newCode}`
    );
    if (next !== doc) fs.writeFileSync(p, next, 'utf8');
  }

  console.log(`Version bumped: ${oldName} (${oldCode}) → ${newName} (${newCode})`);
  return { oldCode, newCode, oldName, newName };
}

function firstExisting(candidates) {
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

const javaHome = process.env.JAVA_HOME || firstExisting([
  'C:\\Program Files\\Android\\Android Studio\\jbr',
  'C:\\Program Files\\Java\\jdk-17',
  'C:\\Program Files\\Java\\jdk-21'
]);

const homeDir = process.env.HOME || process.env.USERPROFILE || '';
const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || firstExisting([
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk'),
  path.join(homeDir, 'AppData', 'Local', 'Android', 'Sdk'),
  path.join(homeDir, 'Library', 'Android', 'sdk'),
  path.join(homeDir, 'Android', 'Sdk')
]);

const env = { ...process.env };
if (javaHome) env.JAVA_HOME = javaHome;
if (androidHome) {
  env.ANDROID_HOME = androidHome;
  env.ANDROID_SDK_ROOT = androidHome;
}

const pathParts = [];
if (javaHome) pathParts.push(path.join(javaHome, 'bin'));
if (androidHome) {
  pathParts.push(path.join(androidHome, 'platform-tools'));
  pathParts.push(path.join(androidHome, 'cmdline-tools', 'latest', 'bin'));
}
env.PATH = [...pathParts, env.PATH || ''].join(path.delimiter);

const isWin = process.platform === 'win32';
const gradlew = isWin
  ? path.join(androidDir, 'gradlew.bat')
  : path.join(androidDir, 'gradlew');
const extraArgs = process.argv.slice(2).filter((a) => a !== '--no-bump');
const gradleArgs = extraArgs.length > 0 ? extraArgs : ['assembleDebug', '--no-daemon'];

const bumped = bumpAndroidVersion();

console.log(`Building Android APK in: ${androidDir}`);
if (bumped) console.log(`App version: ${bumped.newName} (versionCode ${bumped.newCode})`);
if (env.JAVA_HOME) console.log(`JAVA_HOME=${env.JAVA_HOME}`);
if (env.ANDROID_HOME) console.log(`ANDROID_HOME=${env.ANDROID_HOME}`);

const result = spawnSync(gradlew, gradleArgs, {
  cwd: androidDir,
  env,
  stdio: 'inherit',
  shell: isWin
});

process.exit(result.status ?? 1);
