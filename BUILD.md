# 酒馆 - 打包说明

本项目支持打包为 **Windows 便携版**、**Android APK** 和**网页版**。

## 目录结构

```
jiuguan/
├── dist/
│   ├── windows/          # Windows 打包输出
│   ├── android-web/      # Android 前端资源（中间产物）
│   └── web/              # 网页版（浏览器直接打开）
├── android/              # Capacitor Android 工程（APK 构建目录）
├── scripts/              # 构建脚本
├── src/                  # 前端源码
├── main.js               # Electron 主进程
├── preload.js            # Electron 安全桥接
├── index.html            # 应用入口
└── capacitor.config.json # Capacitor 配置
```

## Windows 版本

### 打包

```bash
npm run build:win
```

输出：`dist/windows/酒馆 <版本>.exe`（便携版，单文件）

### 运行

直接双击 exe。首次运行会在 exe 同级目录创建 `data/` 文件夹，所有角色卡、聊天记录、配置都会保存在这里。

## Android 版本

### 一键构建（推荐）

```bash
npm run build:android
```

依次执行：构建前端资源（`dist/android-web/`）→ `cap sync` 同步进 `android/` 工程 → Gradle 打包 APK。

构建脚本会自动探测 `JAVA_HOME` 与 Android SDK（未配置环境变量时按常见安装路径查找），一般无需手动配置。

产物位于：

```
android/app/build/outputs/apk/debug/app-debug.apk
```

传到手机安装即可。

### 分步执行

```bash
npm run build:android:assets   # 仅构建前端资源
npm run build:android:sync     # 仅同步到 android/ 工程
npm run build:android:apk      # 仅打包 APK
```

### 发布新版本

**自动升版：** 执行 `npm run build:android` / `build:android:apk` 时，脚本会自动：

- `versionCode` +1  
- `versionName` 末段 +1（如 `2.1.76` → `2.1.76`）  
- 同步改写 `android/app/build.gradle`（并尽量更新 README/BUILD 中的版本字样）

跳过升版（仅重打同号）：`SKIP_VERSION_BUMP=1` 或 `node scripts/build-android-apk.js --no-bump`

也可手动改 `android/app/build.gradle`：

```gradle
versionCode 130        // 整数，每版 +1（覆盖安装时系统据此判断新旧）
versionName "2.1.76"   // 显示给用户的版本号
```

### 数据存储

Android 版本使用 Capacitor Filesystem 插件，数据存储在应用私有目录中。App 通过前台服务保持后台网络连接（首次启动会请求通知权限，用于显示前台服务通知）。

## 网页版

### 打包

```bash
npm run build:web
```

输出：`dist/web/` 目录，包含 `index.html`、`app.bundle.js` 和 `styles.css`。

### 运行

直接双击 `dist/web/index.html`，或在手机浏览器中打开该文件即可运行。

### 注意事项

- 数据存储在浏览器的 **IndexedDB** 中，不同浏览器/设备之间不共享。
- 把 `dist/web/` 整个文件夹拷贝到手机，用手机浏览器打开 `index.html`，数据会存在该手机的浏览器里。
- API 调用使用浏览器 `fetch`，需要你的 API 服务端允许跨域（CORS）。如果直接通过 `file://` 打开，部分浏览器可能限制外部请求；建议通过本地 HTTP 服务器或静态托管部署。
- 头像上传使用系统文件选择器，手机浏览器通常支持。

## 开发运行

```bash
npm start
```

以 Electron 模式启动，数据存放在 `%APPDATA%/jiuguan/data/`。

## 构建全部

```bash
npm run build:all
```

这会依次构建 Windows、Android 和网页版。
