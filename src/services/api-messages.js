/**
 * 消息构建：buildMessages + 记忆内容格式化
 */

import { getConfig } from './storage.js';
import { EVENT_SYSTEM_RULE, RANDOM_NPC_RULE, CHARACTER_CALIBRATION_RULE, buildImmersiveActingRule } from './narrative-rules.js';
import { isPaidImageProvider } from './image-gen.js';
import { sanitizeHistoryIllustrationMarkers } from './illustration-markers.js';
import { trimHistoricalActionOptions, buildActionOptionContext } from './action-options.js';
import { insertAuthorNote, shouldInjectAuthorNote, storyUserTurnCount } from './author-note.js';
import { resolveWorldBookInjectionParts } from './world-book.js';
import { assembleCardDescription, buildOffscreenRosterBlock } from './card-modules.js';
import { resolveCardPrompt } from './prompt-library.js';
import { formatCurrentMemoryState, formatRecentMemoryIndexes, formatRecalledTurns, RECENT_RAW_TURNS } from './memory-engine.js';
import { formatLongTermMemories } from './memory-long-term.js';

// 思维链预填充文本：开启后追加为 messages 最后一条 assistant 消息，强制模型从此处续写
export const THINKING_PREFILL = '<思考>';

/**
 * 构建发送给 API 的 messages 数组
 * @param {Object} character 角色卡
 * @param {Array} historyMessages 历史消息（当前对话中）
 * @param {string} userMessage 用户刚输入的消息
 * @param {Object} memory 对话记忆模块
 * @param {Object} seedArchive 插图种子档案 {角色名: 种子数}（可选）
 * @param {Object} [options]
 * @param {string} [options.webSearchRef] 本轮挂载的联网参考摘要（仅注入本次请求，不进历史）
 * @param {Object} [options.authorNote] 作者注释 {text, depth, frequency}。不进历史、不进记忆
 */
export async function buildMessages(character, historyMessages, userMessage, memory, seedArchive, options = {}) {
  const messages = [];
  const webSearchRef = (options && options.webSearchRef) ? String(options.webSearchRef).trim() : '';
  // 元指令模式：用户输入以 $ 开头——跳过格式/思维链/插图等全部剧情向注入，只留设定与记忆供答题
  const metaCommand = options && options.metaCommand === true;

  // 全局配置（思考链输出开关 / 思维链预填充等）
  const config = await getConfig();
  const cfgApi = config.api || {};
  // 原生 extended thinking 生效条件：Anthropic 格式 + 推理强度非关闭
  const nativeThinking = cfgApi.format === 'anthropic'
    && cfgApi.reasoningEffort && cfgApi.reasoningEffort !== 'off';
  // 开原生思考时，忽略提示词版 <思考>（避免真思考 + 假装思考重复）
  const thinkingOn = !!(cfgApi.enableThinking === true) && !nativeThinking;

  // System prompt：卡内模块（背景→主角→配角）+ 主控信息 + 长期记忆 + 输出格式约束
  let systemContent = assembleCardDescription(character);

  if (character.mainControl && (character.mainControl.name || character.mainControl.description)) {
    systemContent += '\n\n【主控信息】';
    if (character.mainControl.name) {
      systemContent += '\n主控名称：' + character.mainControl.name;
    }
    if (character.mainControl.description) {
      systemContent += '\n' + character.mainControl.description;
    }
  }

  // 不在场重要NPC名单（卡级）：非空时只有名单内角色拥有常驻场外状态，静态文本可进缓存
  const offscreenRoster = buildOffscreenRosterBlock(character);
  if (offscreenRoster) {
    systemContent += '\n\n' + offscreenRoster;
  }

  // 普通世界书仍在设定区；默认破甲条目单独留到 system 最末尾，避免被后续内容稀释。
  const { worldBookBlock, finalBlock: finalWorldBookBlock } = await resolveWorldBookInjectionParts(character, historyMessages, userMessage);
  if (worldBookBlock) {
    systemContent += '\n\n' + worldBookBlock;
  }

  if (character.enableRandomNarrative !== false && !metaCommand) {
    systemContent += '\n\n【叙事规则：事件系统】\n' + EVENT_SYSTEM_RULE;
    systemContent += '\n\n【叙事规则：随机 NPC 生成】\n' + RANDOM_NPC_RULE;
  }

  // 思考链输出：全局开关打开且本卡有思考格式时，作为独立段落放在输出格式之前
  // 输出格式/思维链来源：卡级填写覆盖，留空继承提示词库全局默认（noGlobalPrompts 卡留空即不注入）
  const resolvedThinkingFormat = resolveCardPrompt(character, config, 'thinkingFormat');
  const resolvedOutputFormat = resolveCardPrompt(character, config, 'outputFormat');
  if (thinkingOn && resolvedThinkingFormat && !metaCommand) {
    systemContent += '\n\n【思考过程】\n回复正文之前，你必须先按以下要求输出思考过程：\n\n' + resolvedThinkingFormat;
  }

  if (resolvedOutputFormat && !metaCommand) {
    systemContent += '\n\n【输出格式要求】\n你必须严格按照以下 Markdown 格式回复：\n\n' + resolvedOutputFormat;

    // 自动提取输出格式里的 >### 标题，生成模块顺序清单
    const headings = [];
    const headingRegex = /^>###\s*(.+)$/gm;
    let match;
    while ((match = headingRegex.exec(resolvedOutputFormat)) !== null) {
      headings.push(match[1].trim());
    }

    if (headings.length > 0) {
      systemContent += '\n\n【模块顺序清单】回复必须按顺序包含以下 ' + headings.length + ' 个模块，缺一不可：\n' +
        headings.map((h, i) => `${i + 1}. ${h}`).join('\n');
      systemContent += '\n\n【收尾强制校验】输出完正文后，最后一步必须完整输出模块「' + headings[headings.length - 1] + '」。' +
        '如果因长度限制无法完成，请优先压缩正文，但绝对不允许删除、省略或截断该模块。';
    }

    systemContent += '\n\n【强制要求】在输出回复前，请再次仔细阅读并核对上面的输出格式与模块顺序清单。' +
      '回复时必须严格、完整、逐条地按照该格式执行，不得省略、合并或跳过任何模块。';
  }

  // 沉浸演绎·反AI腔总则：放在输出格式要求之后（先立格式、再立腔调），静态文本可进缓存
  // 总开关+四个子开关在「其他设置 → 生成行为」（behavior.immersiveActing 等），默认全开；
  // 子开关可只留部分条目（按模型病灶微调），全部关闭则不注入
  const immersiveRule = buildImmersiveActingRule(config.behavior || {});
  if (immersiveRule) {
    systemContent += '\n\n' + immersiveRule;
  }

  // 插图功能（App 级开关）：规则文本是静态的，放在记忆区之前可进缓存
  const imageEnabled = config.ui && config.ui.imageEnabled === true;
  const imageProvider = (config.image && config.image.provider) || 'pollinations';
  if (!metaCommand && imageEnabled && isPaidImageProvider(imageProvider)) {
    // 付费模式（Seedream / Grok / Gemini）：AI 只输出空标记，画面描述由副 API 根据回复内容总结生成
    systemContent += '\n\n【插图功能】当且仅当本轮场景中存在女性角色时，才在最末尾（所有模块之后）输出插图模块；没有女性角色时完全不输出插图模块。每轮最多一张。格式（严格照抄，括号内不写任何内容）：\n' +
      '>### 🖼️插图\n![角色名](seedream://)\n' +
      '选角规则：有女性角色时选本轮互动中最重要的那一位（通常是主控的互动对象）；没有女性角色时跳过插图模块。\n' +
      'alt 文本规则【强制】：只写该女性角色名，禁止写场景描述或"主控"。\n' +
      '禁止在括号内填写任何描述或链接，画面描述由 App 根据你的回复正文自动生成。\n' +
      '【绝对禁止】禁止输出 local-img:// 或任何本地文件路径、http 图片链接；你能输出的插图格式只有上面这一种空标记。';
  } else if (!metaCommand && imageEnabled) {
    // 免费模式（pollinations）：AI 直接拼在线生图 URL
    // NSFW 开关（插图设置）：开=提示词允许成人描写、去掉 SFW 后缀；关=维持全年龄向机械约束
    const pollinationsNsfw = config.image && config.image.pollinationsNsfw === true;
    systemContent += '\n\n【插图功能】当且仅当本轮场景中存在女性角色时，才在最末尾（所有模块之后）输出插图模块；没有女性角色时完全不输出插图模块。每轮最多一张。格式：\n' +
      '>### 🖼️插图\n![角色名](https://image.pollinations.ai/prompt/{英文描述}?nologo=true&seed={种子数})\n' +
      '画面人物：永远只画 1 位女性角色单人图，禁止主控入画，禁止多人同框。\n' +
      '选角规则：有女性角色时选本轮互动中最重要的那一位（通常是主控的互动对象）；没有女性角色时跳过插图模块。\n' +
      'alt 文本规则【强制】：只写该女性角色名，禁止写场景描述或"主控"。\n' +
      'seed 规则【强制】：使用【插图种子档案】中该角色对应的种子作为基础 seed；当本轮动作/构图与上一轮明显不同时，在基础 seed 上加 1-20 的偏移（如 233→237），让构图跟着剧情变化；脸的一致性靠外貌描述词维持，不靠 seed。档案没有的新角色才可自定 100-999 的数字（App 会自动归档）。\n' +
      '英文描述公式：角色外貌（优先从角色卡设定原文提取）+ 当前衣着 + 当前动作姿态（按下方的可达姿势映射翻译）+ 表情神态 + 极简场景背景（仅作氛围点缀），逗号分隔，必须全英文，末尾统一加 "' + (pollinationsNsfw ? 'solo female' : 'SFW, solo female') + '"。禁止在 URL 上添加 width/height 等任何其他参数。\n' +
      '外貌描述优先级【最高优先级】：必须优先使用角色卡设定中的详细外貌原文（神似明星、面部特征、气质、辨识度细节等）；设定未明确时才少量参考状态栏🙂样貌字段。禁止只拿状态栏的简短外貌敷衍生成。\n' +
      '动作姿态【必填+可达姿势映射】：必须把状态栏👣动作字段的意思翻译进英文描述，禁止整个省略；但生图模型只能画出"脸朝镜头"的人像，翻译时必须把不可达姿势映射为最接近的可画姿势：' +
      '趴/俯卧 → "lying on side on {家具}, propped up on elbows, head turned to camera"；' +
      '背对/背影 → "looking back over shoulder at camera"；' +
      '躺 → "lying back, head turned to camera"；' +
      '坐/站/倚靠等本来就能看到脸的姿势 → 直接直译。' +
      '动作里的支撑物与手部细节（扶手/靠垫/抠抓/撑）尽量保留；头部指令永远朝向镜头。' +
      '示例：状态栏"趴在沙发扶手上、手肘撑着靠垫"→ "lying on side on leather sofa, propped up on elbows against armrest, head turned to camera"。\n' +
      (pollinationsNsfw
        ? '内容尺度【NSFW 模式】：衣着、身体状态与亲密描写按本轮正文与状态栏如实翻译，允许裸露与成人词汇；画面仍然只有她 1 人，禁止主控入画、禁止多人同框。\n' +
          '动作姿态无需规避【重要】：动作按剧情如实映射，亲密与性行为姿态同样翻译成可画姿势，不要为了"安全"而改写成僵硬站姿。'
        : '内容安全：衣着描述必须全年龄向，严禁裸露/性暗示词汇；' +
          '状态栏含裸露衣着时禁止照抄，自动改写为安全表达（浴巾包裹/被子遮挡/家居便服等）。\n' +
          '动作姿态无需规避【重要】：动作本身按剧情如实映射即可，趴、躺、倚、靠、抱、亲吻等日常与亲密姿态都可以写入英文描述，只需避免露骨的性行为词汇，不要为了"安全"而把动作改写成僵硬站姿。');
  }

  const memoryOn = character.memoryEnabled !== false;
  // 记忆开启时通常最近1轮；后台滞后多久就完整携带多久，不能截断后又从连续索引排除。
  // 记忆关闭时才使用卡级 0～50 轮限制。
  const rawWindow = resolveRawWindowSize(character, memoryOn, options && options.rawWindowOverride);
  // 旧轮菜单剥离，最近一轮完整保留作格式示范与数字映射；不修改本地聊天
  const recentHistory = trimHistoricalActionOptions(sliceRecentTurns(historyMessages, rawWindow));

  // 注入顺序：长期记忆（每10轮变一次，紧跟静态区便于前缀缓存命中）→ 当前状态账本 → 连续剧情脉络 → 召回历史。
  const longTermBlock = memoryOn ? formatLongTermMemories(memory) : '';
  if (longTermBlock) systemContent += '\n\n' + longTermBlock;
  const recallMentionText = Array.isArray(options && options.recalledTurns)
    ? options.recalledTurns.map((r) => [
      r && r.entry && r.entry.index && r.entry.index.title,
      r && r.entry && r.entry.index && r.entry.index.summary,
      ...((r && r.entry && r.entry.index && Array.isArray(r.entry.index.characters)) ? r.entry.index.characters : [])
    ].filter(Boolean).join(' ')).join('\n')
    : '';
  const stateMentionText = [
    String(userMessage || ''),
    ...recentHistory.map((m) => String(m && m.content || '')),
    recallMentionText
  ].filter(Boolean).join('\n');
  const currentStateBlock = memoryOn ? formatCurrentMemoryState(memory, { mentionText: stateMentionText }) : '';
  if (currentStateBlock) systemContent += '\n\n' + currentStateBlock;
  const recentIndexBlock = memoryOn ? formatRecentMemoryIndexes(memory, {
    recalledTurns: options && options.recalledTurns,
    rawWindowTurnIds: options && options.rawWindowTurnIds
  }) : '';
  if (recentIndexBlock) systemContent += '\n\n' + recentIndexBlock;
  const recalledBlock = memoryOn ? formatRecalledTurns(options && options.recalledTurns, historyMessages) : '';
  if (recalledBlock) systemContent += '\n\n' + recalledBlock;

  // 对话补充设定：用户手动维护的单档覆盖补丁（记忆编辑器「补充」页签）；
  // 与角色卡初始设定冲突时以本区为准，仅当前对话生效（独立于记忆总结开关，关闭记忆时仍保留世界/模拟器设定）
  const supplement = memory ? String(memory.supplement || '').trim() : '';
  if (supplement) {
    systemContent += '\n\n【对话补充设定】（用户对本剧情的补充与修正，仅当前对话生效；与角色卡初始设定冲突时以本区为准）\n' + supplement;
  }

  // 记忆修正通道：允许主模型上报记忆矛盾（开关在「其他设置 → 生成行为」，误报多可关）
  if (!metaCommand && memoryOn && config.behavior && config.behavior.memoryCorrection !== false) {
    systemContent += '\n\n【记忆修正通道】如果你发现【当前状态账本】、【连续剧情脉络】或【长期记忆】与当前剧情现状存在明确矛盾，在本轮回复最末尾（所有模块之后）另起一行输出「记忆修正：一句话说明实际情况」。仅在确有矛盾时输出；拿不准或没有矛盾时绝对禁止输出该行；禁止写进正文叙述；不要每轮都输出。';
  }

  // 插图种子档案：随生图不断更新，放在记忆区之后（动态区，不进缓存）
  // 仅 pollinations 模式使用；seedream/gemini 无 seed 参数，不需要档案
  // 记录形态为 {seed, anchor}（免费生图记忆）；注入只给 AI 看 seed，英文锚点由 App 机械拼 URL 用
  if (!metaCommand && imageEnabled && imageProvider === 'pollinations' && seedArchive && typeof seedArchive === 'object') {
    const entries = Object.entries(seedArchive);
    if (entries.length > 0) {
      systemContent += '\n\n【插图种子档案】' + entries.map(([name, rec]) => {
        const seed = (rec && typeof rec === 'object') ? rec.seed : rec; // 旧数值形态防御
        return `${name}=${seed}`;
      }).join('；');
    }
  }

  // 元指令模式说明：替代全部剧情向注入（格式/思维链/插图等已在上方跳过），剧情状态本轮冻结
  if (metaCommand) {
    systemContent += '\n\n【元指令模式】本轮用户输入以 $ 开头，是系统指令而非剧情内容：不推进剧情与时间、不输出任何格式模块（状态栏/世界信息/行动选项/插图等一律不输出）、不写思维链。基于角色卡、世界书、当前状态账本、连续剧情脉络、长期记忆与对话补充设定，直接、如实地回答指令本身；若指令要求修改设定或剧情走向，明确确认你将如何执行。';
  }

  // 默认破甲条目是 system 的最后一段；解绑或关闭世界书时此块为空，不会残留。
  if (finalWorldBookBlock) {
    systemContent += '\n\n' + finalWorldBookBlock;
  }

  messages.push({
    role: 'system',
    content: systemContent
  });

  const latestAssistant = [...recentHistory].reverse().find((msg) => msg.role === 'assistant');
  const actionOptionContext = metaCommand ? '' : buildActionOptionContext(latestAssistant && latestAssistant.content, userMessage);

  for (const msg of recentHistory) {
    // meta 指令轮留在历史里（改剧情类指令才能持续生效），但带元标记，防止 AI 当成剧情对话
    const content = sanitizeHistoryIllustrationMarkers(msg.content);
    if (msg.meta === true) {
      messages.push({
        role: msg.role,
        content: (msg.role === 'user' ? '【系统指令】（非剧情输入，未推进剧情）\n' : '【指令答复】\n') + content
      });
    } else {
      messages.push({ role: msg.role, content });
    }
  }

  // 当前用户输入；联网参考仅挂在本轮 user 前（不写历史、不进记忆）
  const userContent = webSearchRef
    ? (webSearchRef + '\n\n【用户本轮输入】\n' + userMessage)
    : userMessage;
  // 选项事实边界 + 人设校准紧跟本轮输入，仅存在于 API 请求；元指令无需注入，人设校准可在「其他设置 → 生成行为」关闭
  const calibrationOn = !(config.behavior && config.behavior.characterCalibration === false);
  const requestUserContent = metaCommand
    ? userContent
    : [userContent, actionOptionContext, calibrationOn ? CHARACTER_CALIBRATION_RULE : ''].filter(Boolean).join('\n\n');
  messages.push({
    role: 'user',
    content: requestUserContent
  });

  // 作者注释：元指令轮不插。插在预填充之前，深度 0 时紧挨本次生成，预填充仍是最后一条。
  if (!metaCommand && shouldInjectAuthorNote(options.authorNote, storyUserTurnCount(historyMessages) + 1)) {
    insertAuthorNote(messages, options.authorNote);
  }

  // 思维链预填充（实验）：开关开启时在末尾追加 assistant 开头，强制模型先续写思维链再写正文
  // prefix 字段是 DeepSeek 官方前缀续写协议要求（仅最后一条 assistant 消息生效）
  // 原生思考生效时跳过：Anthropic thinking 模式不允许 assistant 前缀续写
  if (config.api && config.api.prefillThinking === true && !nativeThinking) {
    messages.push({ role: 'assistant', content: THINKING_PREFILL, prefix: true });
  }

  return messages;
}

/**
 * 历史消息插图标记清洗：已移至 illustration-markers.js（与记忆总结路径共用同一实现）
 */

export function resolveRawWindowSize(character, memoryOn, override) {
  if (memoryOn) {
    const value = Number(override);
    return Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : RECENT_RAW_TURNS;
  }
  const value = Number(character && character.rawWindowTurns);
  return Number.isFinite(value) ? Math.max(0, Math.min(50, Math.trunc(value))) : 3;
}

function sliceRecentTurns(history, maxTurns) {
  if (!Array.isArray(history)) return [];
  if (maxTurns <= 0) return [];
  let userCount = 0;
  let start = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    // meta 指令轮（$开头）不占窗口坑位，只数剧情轮
    if (history[i].role === 'user' && history[i].meta !== true) {
      userCount++;
      if (userCount === maxTurns) {
        start = i;
        break;
      }
    }
  }
  return history.slice(start);
}
