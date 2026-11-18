# 工程结构优化说明

> 状态：规划（随拆分进度更新）  
> 原则：**先拆文件、不改行为**；每步可运行、可打 APK；避免大爆炸式重写。

---

## 1. 现状问题

| 文件 | 约行数/体积 | 问题 |
|------|-------------|------|
| `src/pages/chat.js` | ~2000 行 / 96KB | 发送、流式、记忆回调、插图 UI、分页搜索全堆一起 |
| `src/pages/settings.js` | ~1200 行 / 72KB | API 设置 + 其他设置 + 备份 + 生图测试 UI |
| `src/services/image-gen.js` | ~1100 行 / 78KB | 多后端、镜头、衣着库、compose 提示词 |
| `src/pages/memory-editor.js` | ~700 行 | 可接受，页签再涨可再拆 |
| `src/services/storage.js` | ~中等 | PATHS 与 CRUD 集中，暂可不动 |

`src/pages/chat.js.bak` 已删除（无唯一逻辑）。

后果（历史）：难搜、难测、合并冲突多、新人不敢改——通过拆分缓解。

---

## 2. 目标形态（建议）

```
src/
├── app.js
├── pages/
│   ├── home.js
│   ├── character-edit.js
│   ├── chat/
│   │   ├── index.js              # renderChat 入口，组装依赖
│   │   ├── chat-view.js          # DOM 骨架与基础绑定
│   │   ├── chat-messages.js      # 渲染气泡、分页、搜索跳转
│   │   ├── chat-send.js          # 组消息、流式、中止、空窗
│   │   ├── chat-memory-hooks.js  # 总结 catch-up、压缩、状态条
│   │   └── chat-illustration.js  # 插图按钮、灯箱、手动提示词
│   ├── memory-editor.js          # 或 memory-editor/
│   ├── settings/
│   │   ├── index.js              # 导出 renderApiSettingsModal 等（保持对外 API）
│   │   ├── api-settings.js       # 主/副/搜索 API
│   │   ├── other-settings.js     # 插图/界面/行为/备份
│   │   └── settings-shared.js    # escapeHtml、方案下拉等
│   ├── world-book-manager.js
│   └── token-stats.js
├── services/
│   ├── api*.js                   # 保持现有切分
│   ├── image-gen/
│   │   ├── index.js              # 对外 API 与现 image-gen.js 一致
│   │   ├── providers.js          # Seedream/Gemini/Grok/pollinations
│   │   ├── compose.js            # 提示词组装、镜头
│   │   ├── outfit-library.js     # 强制衣着库
│   │   └── anchors.js            # 与锚点/种子相关（若适合）
│   ├── api-memory.js
│   ├── world-book.js
│   └── storage.js
└── utils/
```

**对外入口不变**：`app.js` 仍 `import { renderChat } from './pages/chat.js'` —— 可用 `pages/chat.js` 做 re-export：

```js
// src/pages/chat.js
export { renderChat } from './chat/index.js';
```

这样改 import 面为零。

---

## 3. 拆分原则

1. **行为锁定**：拆分前后同一操作（发送、总结、生图、保存设置）结果一致。  
2. **先抽纯函数，再搬 UI**：例如消息列表渲染、状态栏日期解析，无 DOM 依赖的先迁到 `utils` 或 `services`。  
3. **一次只动一个巨石**：先 chat 或先 settings，不要并行大拆。  
4. **禁止顺手重构业务**：拆文件时不改记忆规则、不改 prompt。  
5. **Android 验证**：每完成一大块 `npm run build:android:assets` + 真机点发送/记忆/设置。

---

## 4. 推荐顺序

### Phase A — 清理与边界（0.5 天级）

- [ ] 确认并处理 `chat.js.bak`（删或移到 `archive/`）  
- [ ] README / 本文档与目录约定对齐（已做 README）  
- [ ] 列出 `chat.js` / `settings.js` 的函数清单（注释分区即可）

### Phase B — settings 拆分（风险低）

`settings.js` 已有两个导出：`renderApiSettingsModal`、`renderOtherSettingsModal`，天然两文件：

1. `settings/api-settings.js`  
2. `settings/other-settings.js`  
3. `settings/index.js` 或根 `settings.js` re-export  
4. 共享：`escapeHtml`、profile 下拉、`applyFontSize`

验收：打开 API 设置 / 其他设置、保存、测连接、导入导出。

### Phase C — image-gen 拆分（风险中）

按「提供商 / 组装 / 衣着库」切开，**保持所有 export 名称与路径**：

- 其它文件继续 `from '../services/image-gen.js'`  
- `image-gen.js` → re-export `./image-gen/index.js`

验收：各后端生图、强制衣着、镜头词、设置页试生成。

### Phase D — chat 拆分（风险高，收益最大）

建议子步骤：

1. **chat-illustration.js**：插图相关 DOM 与生成调用（依赖面相对清晰）  
2. **chat-messages.js**：历史渲染、分页、搜索  
3. **chat-memory-hooks.js**：`summarizeTurn` catch-up、压缩、重试条  
4. **chat-send.js**：发送主路径与流式  
5. **index.js**：状态（currentChat、abort）放一处，向下注入

注意：chat 内闭包状态多，优先 **传参 / 小 ctx 对象**，避免循环依赖。

验收：发送、空窗、中止、记忆总结、插图、搜索跳转、多会话切换。

### Phase E — 可选加固

- [x] 对 `normalizeFacts` / 世界书激活 / 脱敏合并等关键纯函数加最小单测（`tests/*.test.mjs`，`node --test`，2026-07-31；`buildMessages` 待补）  
- [x] 数据迁移集中：`services/migrations.js`（config/chat 幂等步骤表，替代散落的补默认逻辑，2026-07-31）  
- [x] ESLint 最小配置接入（只抓 bug；首扫清理 5 处死代码，2026-07-31）  
- [ ] `storage` 按 domain 分子模块（characters / chats / config）— 仅当继续膨胀时  
- [ ] 删除死代码与重复样式（死代码已随 ESLint 首扫清过一轮，样式未查）

---

## 5. 明确不做（本轮结构优化）

- 不上 TypeScript / 打包器大改（Electron 已直接吃 src；Android 拷贝 android-web）  
- 不引入 React/Vue  
- 不实现向量记忆  
- 不为拆分而改变用户可见文案与默认配置  

---

## 6. 依赖关系简图（拆分时注意方向）

```
app.js
  → pages/* 
       → services/api-messages → api-memory / world-book / storage
       → services/api → api-transport / anthropic
       → services/image-gen
       → services/search-api
       → utils/*

禁止：services → pages
慎用：pages/A → pages/B（memory-editor 已被 chat 引用，可接受；避免再织网）
```

---

## 7. 进度记录

| 阶段 | 状态 | 日期 |
|------|------|------|
| README 对齐现状 | 完成 | 2026-07-29 |
| 本文档 | 完成 | 2026-07-29 |
| Phase A 清理 | 完成：已删 `src/pages/chat.js.bak` | 2026-07-29 |
| Phase B settings | 完成：拆为 `settings/api-settings.js` + `other-settings.js` + `settings-shared.js`，`pages/settings.js` 仅 re-export | 2026-07-29 |
| Phase C image-gen | 待做 | |
| Phase D chat | 完成：D1–D4 列表/记忆 + D5 发送流拆至 `chat/chat-send.js`，`chat.js` 余 ~540 行 | 2026-07-31 |

### Phase B 结果目录

```
src/pages/settings.js                 # re-export 入口（app.js 无需改）
src/pages/settings/
  ├── api-settings.js                 # 主 / 副 / 搜索 API
  ├── other-settings.js               # 界面、插图、行为、调试、备份
  └── settings-shared.js              # escapeHtml / 方案下拉 / applyFontSize
```

### Phase D 结果目录（D1–D5 全部完成）

备份：`archive/chat.js.before-split-2026-07-29.js`

```
src/pages/chat.js                     # 聊天页组装：事件绑定、工具面板、联网挂载（~540 行，原 ~2165）
src/pages/chat/
  ├── chat-send.js                    # 发送 / 流式 / 自动补全 / 原文记忆召回与后台整理（D5）
  ├── chat-utils.js
  ├── chat-image.js
  ├── chat-markdown.js
  ├── chat-message-ui.js
  ├── chat-illustration.js            # 插图 controller
  ├── chat-message-list.js            # 分页 / 轮次 / 搜索
  ├── chat-memory-ui.js               # 状态条 / 重试条
  └── chat-memory-helpers.js          # 轮次/日期/压缩等纯函数
```

**已完成 D1–D5**：发送/流式/记忆回调以 `createSendController(deps)` 形式自持于
`chat-send.js`（isGenerating / abortController / 心跳定时器内部状态），
`chat.js` 仅做组装与输入区交互。

另（2026-07-31）：`listChats` 改为只读 `.meta.json` 索引（`saveChat` 时同步写入，
旧数据首次列表时懒迁移），聊天页不再为下拉框全量读取每个会话 JSON；
生成心跳改为 `.ping` 边车文件。

---

---

*Phase C（image-gen）可与 D 后续并行。*
