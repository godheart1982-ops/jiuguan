# 酒馆 - AI 角色扮演客户端

轻量级 AI 角色扮演客户端：角色卡、多会话、记忆与世界书、插图与联网检索，连接 OpenAI / Anthropic / DeepSeek 等主流 API。  
支持 **Windows 桌面（Electron）**、**Android（Capacitor）**，另可构建纯网页资源。

当前 Android 版本：**2.1.123**（`versionCode` **177**）

---

## 功能特性

### 角色与会话

- **角色卡管理**：创建 / 编辑 / 删除；本地头像、主控信息、分组；分组折叠状态持久化
- **卡内模块**：背景设定 + 可增删的角色模块（每个角色一块设定文本，主角为第一块），按"背景设定→各角色模块"顺序全量常驻注入；老卡的角色描述自动并入第一块角色模块
- **提示词库**（侧边栏 📚）：内置状态栏输出格式/思维链/荒野求生三份模板，可编辑/导出/恢复默认，支持自定义模板（可选类型）；输出格式与思维链在卡编辑页**按卡选择加载**（下拉按类型筛选：输出格式下拉只出输出格式模板、思维链下拉只出思维链模板；卡级文本仍可覆盖，选"无"即不注入）
- **多对话**：每个角色可拥有多条独立会话
- **世界书（类 SillyTavern）**：常驻 / 关键词命中注入；角色卡专属条目 + 侧边栏「世界书库」绑定；扫描深度、递归、大小写；可开「扫描时忽略状态栏」（默认开，剥离 AI 回复的代码块与标题行再匹配，人名只靠正文触发）；不写历史、不进记忆。人物条目建议勾「不可被递归激活」：只在本人被近期聊天提及时加载，避免角色关系网被递归整片勾起
- **输出 / 思考格式**：角色卡内可配输出模块与思考格式等

### API 与连接

- **主 API**
  - OpenAI 兼容 `/v1/chat/completions`
  - Anthropic 原生 `/v1/messages`（含 prompt caching）
  - DeepSeek 思考模式、火山方舟前缀续写等兼容路径
- **副 API（记忆总结）**：可单独填 Base URL / Key / 模型，用于短期总结、长期压缩与精简；留空则回退主 API
- **搜索 API（联网）**：与对话 API 独立（如 AnySearch）；聊天页 🔍 **仅用输入框原文**作查询，不上传角色卡与历史；结果拼进本轮发送，默认不进记忆
- **API 配置方案**：主/副 API 可保存多套方案快速切换（方案命名用应用内输入框，兼容 Electron 无 `prompt`）
- **API 测速 / 跑分**（「API 设置 → 高级」，主/副 API 均可测）：快速 1 次流式 / 完整 = 预热 1 轮 + 正式 N 轮；首 Token P50、总延迟 P95、输出 / 总体 Token/s、请求/分钟、格式遵循（简化状态栏机械校验）、DeepSeek 余额；记录持久化、可删除对比
- **Token 用量统计**：按角色 / 模型 / 日期统计输入、输出、缓存读等

### 记忆系统

- **原文窗口**：最近若干轮完整对话直接携带（角色卡可关记忆后只带原文）
- **短期记忆**：每轮（滞后窗口）由副 API 总结为结构化条目（出场/场景/经过/变化/情绪）；满额自动压缩为长期
- **长期记忆**：阶段情节；短期满额自动压缩（参考最近旧长期保持衔接，旧条目不重写）；支持手动压缩、AI 精简
- **事实备忘（结构化，压缩不清空）**
  - 约定（全量重写核对：AI 每轮拿当前清单逐条对齐，完成即退出待办；已完成仅留最近 5 条供查看）
  - 人物关系（全量重写核对：AI 每轮对齐清单刷新；未提及的旧人物排队尾自然淘汰）
  - **世界动态**：公共事件与重要NPC的场外个人线**分流归档**——公共事件走 facts.worldEvents（按事件名追加合并、同名保留最近3条阶段轨迹，随事实备忘**回流注入**，完结仅作历史参考）；**NPC场外个人线走短期→长期叙事记忆**（events/changes 强制记录其发展，长期整合与精简均保留），重逢时人名召回承接；输出格式「场外动态」字段负责发生（仅跨时段时推进：每天分深夜0-7/上午7-12/下午12-18/晚上18-24四时段，跨时段边界才更新，同时段写"无"；条目末尾带发生时段）；卡编辑页「场外动态角色」可指定名单（留空由AI判断重要NPC），名单外角色不编场外戏
  - **知情情报**：`intel` + `knownBy`（谁可把该情报当已知；「公开」= 在场都可知）；全量重写核对，未提及的旧情报排队尾保守保留；注入硬性知情约束
- **记忆编辑器（全屏）**
  - 第一行页签：短期 / 长期 / 事实
  - 第二行页签：免费生图记忆（种子 + 英文锚点）/ 外貌锚点（付费管线中文锚点）
  - 可手改上述内容并保存
- **可选关闭记忆**：仅按设定轮数携带原文，不再总结/注入记忆块
- **记忆修正通道**：AI 发现长期记忆/事实备忘与剧情矛盾时，在回复末尾上报「记忆修正：…」，总结时按最高优先级自动更正事实备忘（可在「其他设置 → 生成行为」关闭）

> 向量记忆（语义检索预取）仅有设计稿（`docs/vector-memory-design.md`），**未实现**。

### 插图

侧边栏独立 **「插图设置」**（与「其他设置」分离，避免一页过长）。

- 后端：pollinations / 火山方舟 Seedream / 阿里百炼万相 / Google Gemini / xAI Grok Imagine / 手动模式等（pollinations 免费模式可选 NSFW 提示词开关，默认强制 SFW）
- 付费链路可由副 API 整理提示词；图片可存本地
- 人物模式：单人 / 双人（主控背影等，Grok / 手动）
- 镜头：景别 / 朝向 / 俯仰 / 画幅，可关交给模型
- 私密场景强制衣着：占位符由 App 机械替换模板库（含随机配色）
- **外貌身材锚点** + **免费生图记忆**（插图种子 + 英文外貌锚点，免费模式落盘时由 App 机械拼进 pollinations URL 锁脸，种子基准锁定不漂移）：同角色多轮出图更稳
- 点击灯箱放大、缩放拖拽；手动模式可复制提示词去外部 App 生成

### 聊天体验

- **流式输出**；Android 生成时前台保活
- **跟随式滚动**：流式生成中上翻阅读即暂停滚底、回到底部自动恢复；记忆总结 / 插图完成后的重渲染不再强制回底
- **空发送推演**：输入框留空点发送，按设定 / 记忆 / 状态栏自行推演，场景连续性优先（进行中的互动不中断，日程 / 约定仅作兜底）；指令可在「其他设置」自定义
- **作者注释**（聊天页工具面板 📝）：写给 AI 的常驻要求（如"保持她的毒舌"），按深度（0=请求末尾，N=后面留 N 条）与频率（每轮 / 每 N 轮 / 0=暂停）以 system 身份插入每次请求；不进聊天记录、不进记忆，禁止角色回应注释本身
- **长对话分页**加载；消息搜索与轮次跳转
- **对话分支**：消息右键「从这里分支」——该条及之前的消息与全部记忆快照（长期/事实备忘/剧情线/锚点/作者注释）深拷贝为新对话并跳转，原线保留
- 暗色酒馆风格；字体大小等 UI 设置
- 发送前预览（调试用，可开关）

### 数据备份与云同步

- **本地 JSON** 存储，隐私可控
- **整包加密备份**（AES-GCM + PBKDF2）
  - 导出 / 上传云前设置口令（明文输入便于核对，口令不存本机）
  - 导入 / 从云恢复时每次输入口令
  - 加密后含完整配置与 API Key；无口令无法阅读文件内容
  - 兼容旧版明文 / 脱敏备份
- **坚果云 / WebDAV 云备份**（「其他设置」）
  - 默认地址 `https://dav.jianguoyun.com/dav`；用户名=邮箱；密码=官网应用密码
  - **设备名称**区分多端；文件名：`backup-YYYYMMDD-HHmmss-设备名.json`
  - **单击**「从云恢复」：恢复本设备最新一份
  - **长按**「从云恢复」：列出云端目录**全部**备份（含其他设备），自选恢复
- Android 本地导出可走系统分享

---

## 技术栈

| 层 | 技术 |
|----|------|
| 桌面 | Electron |
| Android | Capacitor 8 + 原生 WebView |
| 前端 | 原生 ES Module（HTML / CSS / JS），无 React/Vue |
| 渲染 | marked |
| 存储 | JSON 文件（Electron 用户目录 / Capacitor Filesystem） |
| 流式 HTTP（Android） | capacitor-stream-http-v2 等 |
| 备份加密 | Web Crypto（AES-GCM-256 + PBKDF2-SHA256） |

---

## 快速开始

### 环境

- Node.js（建议 LTS）
- 桌面：无需额外 Android 环境
- Android 打包：需本机 Android SDK；脚本会尝试探测常见 `JAVA_HOME` / `ANDROID_HOME`

```bash
npm install
```

### Windows 桌面

```bash
npm start                 # 开发运行（Electron，改 src 即可测）
npm run build:win         # 便携版 exe → dist/windows/
```

> 说明：`npm start` 只开桌面版；安卓需打 APK 或模拟器，不能用 `npm start` 直接看安卓壳。

### Android

```bash
# 一键：前端资源 → cap sync → Gradle 打 debug APK（默认自动 versionCode/versionName +1）
npm run build:android
```

分步：

```bash
npm run build:android:assets   # → dist/android-web/
npm run build:android:sync
npm run build:android:apk
```

产物：

```
android/app/build/outputs/apk/debug/app-debug.apk
```

跳过升版：`SKIP_VERSION_BUMP=1` 或见 `BUILD.md`。  
更细的打包说明见 **[BUILD.md](./BUILD.md)**。

### 网页资源

```bash
npm run build:web         # → dist/web/
```

---

## 使用说明（简要）

1. **API 设置**（侧边栏）：主 API / 副 API / 搜索 API；可保存多套方案。  
2. **插图设置**（侧边栏）：开关、服务商、Key、衣着库、compose、测试生图。  
3. **其他设置**（侧边栏）：字体、空窗指令、调试预览、**加密备份**、**坚果云 WebDAV**。  
4. **新建角色**：设定描述、主控、输出格式；可开世界书。  
5. 进入 **聊天**；可多会话；留空发送 = 空窗推演。  
6. **编辑记忆**：短期 / 长期 / 事实备忘（含知情）/ 种子 / 锚点。  
7. 需要时用 🔍 联网；用「世界书库」管理公共条目。

### 坚果云备份（简要）

1. 坚果云官网 → 账户信息 → 安全选项 → **添加应用密码**。  
2. 其他设置填写：地址、邮箱、应用密码、**设备名称**（如「手机」）、云端目录。  
3. **上传到云**：输入备份口令 → 加密后上传。  
4. **从云恢复**：单击=本设备最新；长按=全部文件列表自选（可恢复其他设备备份）→ 输入口令解密。

---

## 数据存储位置

### 桌面端（Electron）

```
%APPDATA%/jiuguan/data/
├── config.json           # API / UI / 搜索 / webdav 等配置
├── characters/           # 角色卡 + 头像
├── chats/                # 会话与记忆等（.meta.json=列表索引，.ping=生成心跳，均为边车小文件）
├── worldbooks/           # 独立世界书库（若有）
└── …                     # 生成图等其它本地文件
```

（具体子目录以 `src/services/storage.js` 中 `PATHS` 为准。）

### Android

App 私有目录，经 Capacitor Filesystem 读写。换机请用 **加密备份导出** 或 **WebDAV 云恢复**。

---

## 项目结构

```
jiuguan/
├── index.html              # 入口页
├── main.js / preload.js    # Electron 主进程与桥
├── src/
│   ├── app.js              # 路由、侧边栏、全局状态
│   ├── styles.css
│   ├── pages/
│   │   ├── home.js
│   │   ├── chat.js                 # 聊天页组装（事件绑定、工具面板、联网挂载）
│   │   ├── chat/                   # 聊天子模块
│   │   │   ├── chat-send.js            # 发送 / 流式 / 记忆总结回调
│   │   │   ├── chat-utils.js
│   │   │   ├── chat-image.js / chat-markdown.js
│   │   │   ├── chat-message-ui.js / chat-message-list.js
│   │   │   ├── chat-illustration.js
│   │   │   └── chat-memory-ui.js / chat-memory-helpers.js
│   │   ├── character-edit.js
│   │   ├── memory-editor.js
│   │   ├── world-book-manager.js
│   │   ├── settings.js             # 设置 re-export
│   │   ├── settings/
│   │   │   ├── api-settings.js     # 主/副/搜索 API
│   │   │   ├── image-settings.js   # 插图设置
│   │   │   ├── other-settings.js   # 字体/行为/调试/备份/WebDAV
│   │   │   └── settings-shared.js
│   │   └── token-stats.js
│   ├── services/
│   │   ├── api.js / api-transport.js / api-anthropic.js
│   │   ├── api-messages.js / api-memory.js
│   │   ├── world-book.js / image-gen.js / search-api.js
│   │   ├── storage.js              # 本地存储 + 导出导入（可脱敏）
│   │   ├── migrations.js           # 数据迁移：config/chat 补默认与清残留（集中步骤表）
│   │   ├── webdav-backup.js        # 坚果云 WebDAV
│   │   ├── narrative-rules.js / token-stats.js / foreground.js
│   │   └── illustration-markers.js
│   └── utils/
│       ├── backup-crypto.js        # 整包加密/解密
│       ├── prompt-dialog.js        # 应用内输入框（含备份口令）
│       ├── big-editor.js / image-lightbox.js
│       └── counter.js / tokenizer.js
├── scripts/                # Android / Web 构建脚本
├── tests/                  # 纯函数单测（node --test）
├── android/                # Capacitor Android 工程
├── docs/
│   ├── vector-memory-design.md
│   └── engineering-structure.md
├── BUILD.md
└── package.json
```

---

## 开发说明

- 前端为浏览器 ES Module；改 `src/` 后：
  - 桌面：`npm start`
  - Android：`npm run build:android`（或 assets + sync + apk）
- 工程结构说明见 **[docs/engineering-structure.md](./docs/engineering-structure.md)**
- 关键纯函数有最小单测（`tests/*.test.mjs`，原生 `node --test`，无需额外依赖）：`npm test`
- ESLint 最小配置（`eslint.config.mjs`，只抓 bug 不管风格）：`npm run lint`
- 数据迁移集中在 `src/services/migrations.js`：config/chat 各一张幂等步骤表，加字段只在表尾加一步

---

## 相关文档

| 文档 | 内容 |
|------|------|
| [BUILD.md](./BUILD.md) | Windows / Android / Web 打包细节与升版 |
| [docs/engineering-structure.md](./docs/engineering-structure.md) | 工程拆分与优化顺序 |
| [docs/vector-memory-design.md](./docs/vector-memory-design.md) | 向量记忆设计稿（未实现） |

---

## 版本

- **package.json**：`1.0.0`（npm 包版本，与 App 展示版可不同）
- **Android App**：见 `android/app/build.gradle`  
  当前文档对齐：**2.1.123** / **177**
