# 向量记忆（轮后预取）设计说明

> 状态：设计稿（未实现）  
> 日期：2026-07-29  
> 范围：历史设计稿，基于当时的短/长期记忆体系；当前已改用原文档案 + 当前状态账本 + 副 API 索引召回，本文仅留作参考

---

## 1. 目标与非目标

### 1.1 目标

在长对话中，除「时间窗口 + 短/长期摘要 + 事实备忘」外，增加一层 **语义相关的旧情节召回**：

- **写入**：每轮记忆总结后，将本轮短期摘要写入向量库（一卡一轮）。
- **预取（读出）**：本轮结束后后台分析近况，生成检索点并搜库，**缓存给下一轮**；发送时直接附带，不增加用户可感知等待。
- **配置**：设置页独立「向量 / Embedding API」面板，用户自填 Base URL、API Key、模型名等。

### 1.2 非目标（本期不做）

- 不以向量替代事实备忘；约定 / 关系 / 世界事件 / 知情 **仍全量必带**。
- 不做发送前「先分析再聊」的串行智能（避免拖慢首字）。
- 不把每轮 user/AI **全文**作为向量主库。
- 不做记忆图谱、不做跨会话全局人物库（可按 chatId 隔离即可）。
- 不在本期做「你记得 xxx」口令写入（可后续加；与检索分离）。

---

## 2. 与现有记忆体系的关系

| 层级 | 作用 | 注入时机 |
|------|------|----------|
| 最近 N 轮原文 | 高清当前 | 每轮必带 |
| 短期记忆 | 近段情节摘要 | 每轮必带（列表） |
| 长期记忆 | 压缩后的阶段史 | 每轮必带（列表） |
| 事实备忘 | 硬事实 + 知情约束 | 每轮必带（全量） |
| **向量相关回忆** | 与「当前线」语义相关的旧摘要 | **预取缓存**，下轮附带；失败则省略 |

原则：

- **硬约束走账本，软细节走向量。**
- 向量是增强，关开关或未配置时行为与现网一致。

---

## 3. 总体流程

```
第 N 轮主模型回复完成
    │
    ├─【现有】summarizeTurn
    │     → shortTerm 追加 content
    │     → applyTurnFactsToMemory（promises/relations/worldEvents/intel）
    │
    ├─【新增】若向量记忆启用且配置完整
    │     → embed(content) → 写入本会话向量库 1 条卡片
    │
    └─【新增】轮后预取（异步，不堵 UI）
          输入：近 3 轮完整对话（不截断）+ 近 3 条短期
          副 API：生成 3～5 个检索点
          对各检索点 embed + 相似度检索
          合并去重 Top-K → 写入 chat.memory.prefetch
          saveChat

第 N+1 轮用户发送（含空窗口）
    │
    ├─ buildMessages：必带窗口/短长期/事实
    ├─ 若存在有效 prefetch.items → 注入【相关回忆·预取】
    ├─（可选增强）用户输入较长时：用用户原文即时搜一次，与 prefetch 合并
    └─ 主模型流式回复 → 回到上半段刷新向量与 prefetch
```

用户阅读第 N 轮回复时完成入库与预取 → **第 N+1 轮发送几乎零额外等待**。

---

## 4. 向量库构建（写入策略：方案一）

### 4.1 策略

**每轮记忆总结成功后，存 1 条摘要卡片**（复用 `summarizeTurn` 的 `content`）。

```
一轮结束 → 生成短期摘要 content
  ① → shortTerm（现有）
  ② → 向量库 append/upsert 同一 text
```

不采用：每轮全文入库、每轮拆多条原子事实（后续可选增强）。

### 4.2 卡片数据结构

逻辑结构（实现可落在 `chat.vectorMemory` 或独立存储键，见 §7）：

```ts
type VectorMemoryCard = {
  id: string;              // 稳定 id，建议 `${chatId}:${turnTimestamp}` 或 uuid
  chatId: string;
  text: string;            // 短期摘要 content
  vector: number[];        // embedding
  dim: number;             // 向量维度（换模型时用于校验）
  model: string;           // 写入时使用的 embedding 模型名
  round: number | null;
  turnTimestamp: string | null;
  date: string;            // YYYY-MM-DD
  source: 'short_summary';
  createdAt: number;       // ms
};
```

### 4.3 生命周期

| 事件 | 行为 |
|------|------|
| 短期满额压缩为长期 | **不删除**对应向量卡（旧细节仍可被搜到） |
| 用户在记忆编辑器删某条短期 | **可选**：按 `turnTimestamp` 同步删向量卡；本期可先不联动，仅新写入 |
| 用户清空记忆 | 清空本 chat 向量库 + prefetch |
| 切换 embedding 模型 / 维度变化 | 旧向量不可混用：标记 `stale` 或重建；本期建议 **提示用户「换模后旧卡不参与检索」**，新轮次用新模型写入；提供「清空本会话向量库」按钮（可放设置或记忆编辑） |
| 记忆系统关闭 `memoryEnabled === false` | 不总结、不写向量、不做预取 |

### 4.4 容量

- 按 `chatId` 隔离。
- 软上限建议 **每会话 500～2000 条**；超出丢最旧（FIFO）或按 `createdAt`。
- 单条 `text` 过长时再截断摘要（摘要本身通常很短，一般不必）。

---

## 5. 轮后预取（读出策略）

### 5.1 触发时机

- **主回复结束且记忆总结流程跑完后**（与 catch-up / 重试成功路径一致）。
- 全程 **async / 不阻塞** 聊天气泡与输入框。
- 预取失败：静默降级，仅 `console.warn`，不影响主流程。

### 5.2 分析输入（已拍板）

| 材料 | 规则 |
|------|------|
| 最近 **3 轮** 对话 | user + assistant **完整原文，不截断**（避免只剩状态栏） |
| 最近 **3 条** 短期记忆 | `shortTerm` 末 3 条的 `content` |
| （实现可选） | open 约定 / 最近 intel 标题级一行列表，控制总长 |

副 API 提示中明确分工：

- 近 3 轮原文 → 未收束冲突、在场人物、物件、口径  
- 近 3 条短期 → 只补原文未再提、但仍可能相关的旧线  
- 输出检索点 **3～5 条**，宁缺毋滥、避免重复  

### 5.3 副 API 输出格式

使用现有 **记忆副 API**（`api.memoryApi`，与 summarize 同源解析逻辑），严格 JSON：

```json
{
  "queries": [
    "王思雨 发现 红印 怀疑",
    "张放 对王思雨 隐瞒口径",
    "逐波 颈部 痕迹"
  ],
  "entities": ["王思雨", "逐波", "红印"]
}
```

- `queries`：必填，1～5 条短检索句  
- `entities`：可选，用于后续关键词加成（本期可只做记录，检索以 queries 的向量为主）

### 5.4 检索与合并

对每条 `query`：

1. `embed(query)`（向量 API）  
2. 在本 `chatId` 卡库中余弦相似度 Top-M（如 M=4）  
3. 多 query 结果按 id 去重，按最高分保留  
4. 全局取 Top-K（建议 **K=5**，可配置 3～8）  
5. 可过滤：相似度 &lt; 阈值（如 0.25，按实际模型调）则丢弃  

### 5.5 预取缓存结构（挂在 chat 上）

```ts
type MemoryPrefetch = {
  updatedAt: number;
  basedOnRound: number | null;     // 基于哪一轮结束后生成
  queries: string[];
  items: Array<{
    id: string;
    text: string;
    score: number;
    round: number | null;
    date: string;
  }>;
};
// chat.memory.prefetch: MemoryPrefetch | null
```

### 5.6 下一轮注入

在 `api-messages`（或等价拼装处）增加块，例如：

```text
【相关回忆·预取】（与当前线可能相关的旧摘要，非硬事实；与事实备忘冲突时以事实备忘为准）
1. （第12轮）……
2. （第8轮）……
```

- 无 prefetch / 过期 / 空 items → 不注入该块。  
- **空窗口发送**：不依赖用户字，直接使用 prefetch（最契合预取设计）。  
- **用户长输入（可选二期）**：发送时用用户原文再 embed 搜一次，与 prefetch 合并去重，防止话题急转；一期可不做。

### 5.7 过期策略

- 每轮成功预取后覆盖 `prefetch`。  
- 若用户连续快速发送、上轮预取未完成：本轮无块或沿用更旧 prefetch；**不阻塞发送**。  
- 可选：`basedOnRound` 与当前 `roundCounter` 差 &gt; 2 视为过期不用（一期可放宽）。

---

## 6. 设置页：向量模型（Embedding）配置

### 6.1 产品原则

- 与主 API、副 API（记忆总结）、搜索 API **并列独立**。  
- 用户 **自行填写** Base URL、API Key、模型名；不绑定单一服务商。  
- **未启用或未配全** → 向量写入与预取整条链路跳过，主对话不受影响。

### 6.2 配置结构

写入 `config`（与 `getConfig()` 同文件），建议顶层字段 `embedding`（与 `search` 同级），避免塞进 `api` 造成 chat completion 与 embedding 混用：

```ts
type EmbeddingConfig = {
  enabled: boolean;           // 总开关，默认 false
  baseUrl: string;            // 如 https://api.openai.com/v1 或中转
  apiKey: string;
  model: string;              // 如 text-embedding-3-small / 套餐内向量模型名
  /** 请求路径：默认 OpenAI 兼容 */
  path?: string;              // 默认 /embeddings；若 baseUrl 已含完整 path 可特殊处理
  /** 检索参数（可放 advanced，一期可用默认） */
  topK?: number;              // 默认 5
  minScore?: number;          // 默认 0.25（实现时按模型校准）
  maxCardsPerChat?: number;   // 默认 1000
};
```

`getConfig()` 缺省迁移：

```js
if (!config.embedding) {
  config.embedding = {
    enabled: false,
    baseUrl: '',
    apiKey: '',
    model: '',
    path: '/embeddings',
    topK: 5,
    minScore: 0.25,
    maxCardsPerChat: 1000
  };
}
```

### 6.3 UI 布局（设置弹窗新面板）

与现有「主 API / 副 API / 搜索 API」一致，增加侧栏或 Tab：

**面板名：`向量 API` / `Embedding`**

| 控件 | 说明 |
|------|------|
| 启用向量记忆 | checkbox，`embedding.enabled` |
| API Base URL | 必填（启用时）；placeholder 例 `https://api.openai.com/v1` |
| API Key | password；用户自填 |
| 模型名称 | 必填（启用时）；placeholder 例 `text-embedding-3-small` |
| 请求路径 | 可选，默认 `/embeddings`；兼容不同中转 |
| 从已保存方案读取 | （可选）复用 apiProfiles 只填 URL/Key，模型仍手填 |
| 测试连接 | 按钮：对固定短文本 `测试` 调一次 embed，显示维度与耗时 |
| 说明文案 | 仅用于记忆向量化与检索，不走对话补全；需服务商提供 Embedding 接口 |

**不强制** Temperature / Max Tokens（embedding 通常无此概念）。

保存校验（仅当 `enabled`）：

- `baseUrl`、`apiKey`、`model` 均非空，否则提示并可不拦截保存但自动视为无法工作，或启用时阻止保存并 toast——**建议启用时三字段必填**。

### 6.4 HTTP 约定（实现默认）

默认兼容 **OpenAI Embeddings API**：

```http
POST {baseUrl}{path}
Authorization: Bearer {apiKey}
Content-Type: application/json

{
  "model": "{model}",
  "input": "文本" | ["文本1", "文本2"]
}
```

响应解析：

```json
{
  "data": [
    { "embedding": [0.1, 0.2, ...], "index": 0 }
  ]
}
```

- `baseUrl` 去尾 `/`，`path` 保头 `/`。  
- 若未来需 Azure / 其他协议，可加 `provider` 字段；一期以 OpenAI 兼容为主，与主 API 使用习惯一致。  
- 批量：预取多 query 时尽量 **一次 request 多 input**，降低 RTT。

### 6.5 与副 API 的分工

| 能力 | 使用配置 |
|------|----------|
| 短期/长期总结、精简、**预取检索点生成** | `api.memoryApi`（对话补全） |
| **文本 → 向量**、相似度检索用的 embed | `embedding`（向量 API） |

预取链路会同时依赖两者：副 API 出 queries，向量 API 做 embed。  
仅配其一：能总结但不能向量，或能 embed 但无智能 query——实现上 **两者都完整才跑预取**；仅 embedding 完整时可退化为「用最近 1 条短期 text 当 query」的弱预取（可选，一期可直接 skip 预取分析）。

**一期建议：**

- 写库：只需 `embedding` 完整 + 有短期 content  
- 预取：需 `embedding` + 副 API（或主 API 回退）均可对话  

---

## 7. 存储方案

### 7.1 推荐（一期）

向量卡数量可能较大（含 float 数组），不宜无限塞进超大 chat JSON 若导致卡顿，但一期为减少新存储抽象：

**方案 A（优先，实现简单）**

- `chat.vectorCards: VectorMemoryCard[]`  
- `chat.memory.prefetch`  
- 随 `saveChat` 持久化  

风险：卡片多时 chat 文件变大。缓解：`maxCardsPerChat` + 不存多余 meta；float 可考虑截断小数位（如 6 位）降体积。

**方案 B（二期）**

- 独立键：`vector-memory/{chatId}.json`  
- chat 内只存 prefetch 与计数  

一期采用 **方案 A**，预留迁移到 B 的字段形状。

### 7.2 本地相似度

一期 **暴力余弦** 扫本会话卡片即可（≤2k 条足够）：

```
score = dot(a,b) / (||a|| * ||b||)
```

写入时可预存 `norm` 加速。无需引入外部向量数据库进程（Android 友好）。

---

## 8. 模块拆分（实现指引）

| 文件（建议） | 职责 |
|--------------|------|
| `src/services/api-embedding.js` | resolve 配置、调用 embed、测连通、余弦与 Top-K |
| `src/services/vector-memory.js` | 卡片 CRUD、入库、预取编排、合并去重 |
| `src/services/api-memory.js` | 现有总结；可选导出「生成检索点」prompt 函数 |
| `src/services/api-messages.js` | 注入【相关回忆·预取】 |
| `src/pages/chat.js` | 总结成功后触发 `afterTurnMemoryPipeline` |
| `src/pages/settings.js` | 向量 API 面板 + 保存/测试 |
| `src/services/storage.js` | `getConfig` 迁移 `embedding` 默认值 |

---

## 9. 提示词草案（预取分析）

系统：

```text
你是检索辅助助手。根据给定的近期对话与短期记忆，输出下一轮叙事可能用到的旧记忆检索点。
只输出 JSON，不要解释。
```

用户：

```text
请输出：
{"queries":["短检索句",...],"entities":["人名或物件",...]}

要求：
1. queries 3～5 条，每条短、可检索、含关键实体；不要整句剧情复述。
2. 近3轮原文反映当前未收束线；近3条短期只补旧线。
3. 不要编造未出现的情节。

【近3轮对话】
...不截断...

【近3条短期记忆】
1. ...
2. ...
3. ...
```

---

## 10. 开关与降级矩阵

| 条件 | 写向量 | 预取分析 | 注入预取 |
|------|--------|----------|----------|
| `embedding.enabled` 且 URL/Key/模型齐全 | ✓ | 需对话 API | ✓ |
| embedding 未配 / 关闭 | ✗ | ✗ | ✗ |
| 记忆系统关闭 | ✗ | ✗ | ✗ |
| 总结失败 | ✗ 本轮 | ✗ 本轮 | 沿用旧缓存或空 |
| 仅 embed 成功、分析失败 | ✓ | ✗ | 旧缓存或空 |
| 换 embedding 模型维度不一致 | 新卡写入；旧卡 dim/model 不符则检索跳过 | 同左 | 可能变少 |

---

## 11. UI 其它入口（一期最小）

- **设置**：向量 API 面板（必须）。  
- **记忆编辑器（可选一期）**：展示「本会话向量卡片数」；按钮「清空向量库与预取」。  
- **不强制**在记忆编辑器里逐条改向量卡（与短期同源，改短期不自动 re-embed 可接受；二期再说）。

---

## 12. 实现分期

### Phase 1（建议首发）

1. `config.embedding` + 设置页面板 + 测试连接  
2. `api-embedding.js`：embed + 余弦 Top-K  
3. 总结成功后写入 `vectorCards`  
4. 轮后：3 轮全文 + 3 短期 → 副 API queries → 搜 → `prefetch`  
5. `buildMessages` 注入预取块  
6. 记忆关闭 / 未配置时全跳过  

### Phase 2

- 用户长输入发送时即时补搜合并  
- 记忆编辑器清空 / 卡片数展示  
- 独立文件存储向量卡  
- entities 关键词加成排序  

### Phase 3（按需）

- 「你记得 xxx」显式写入  
- 换模批量重嵌  
- 原子多卡抽取  

---

## 13. 验收标准

1. 未配置向量 API：对话与现网一致，无报错弹窗。  
2. 配置正确并启用：每轮总结后卡片数 +1（同 turn 不重复）。  
3. 总结后后台预取完成，下一轮请求体中可见【相关回忆·预取】（debug 预览可开时检查）。  
4. 空窗口发送也能带上预取（若上轮预取成功）。  
5. 设置页可改 URL / Key / 模型，测试连接返回维度信息。  
6. 事实备忘仍全量注入；知情约束不被预取块覆盖。  
7. 近 3 轮送入预取分析时 **不做原文截断**。  

---

## 14. 已拍板参数一览

| 参数 | 值 |
|------|-----|
| 入库粒度 | 每轮 1 条短期摘要 |
| 预取上下文 | 近 3 轮完整对话 + 近 3 条短期 |
| 近 3 轮截断 | **否** |
| 检索点数量 | 3～5 |
| 注入条数 Top-K | 默认 5 |
| 预取时机 | 轮次结束后后台 |
| 发送前副模型分析 | 否 |
| Embedding 配置 | 用户自填 URL + Key + 模型，独立面板 |
| 硬事实 | 仍走事实备忘全量 |

---

## 15. 开放问题（实现前可再定）

1. 向量卡是否随「删除单条短期」联动删除？（建议 Phase 2）  
2. `minScore` 默认值需按用户常用 embedding 模型试一下再写死。  
3. 预取分析失败时，是否用「最近 1 条短期原文」做单 query 弱预取？（可选增强）  

---

*本文档仅描述设计；实现时以本文 §12 Phase 1 为开工范围。*
