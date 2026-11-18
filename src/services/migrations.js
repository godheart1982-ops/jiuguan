/**
 * 数据迁移：所有「老数据补默认值 / 清残留字段」的逻辑集中于此。
 *
 * 约定：
 * - 迁移按「步骤表」顺序执行，每步幂等（任意时刻重跑结果一致）；
 * - 本项目存储模型是「读时迁移，下次保存自然落成新结构」，不向文件回写版本号——
 *    stamping 只会在每次升级路径上徒增写盘（Android 还要过 bridge），无行为收益；
 * - 以后加字段 = 在对应类型步骤表末尾加一步，别处一律不用动。
 *
 * 依赖说明：migrateChat 需要 api-memory.js 的 facts 纯函数，
 * 与 storage.js 形成「仅运行期调用」的引用环（模块求值期互不访问对方绑定），
 * ESM / esbuild 均可安全解析。
 */

import { emptyFacts, normalizeFacts, applyTurnFactsToMemory } from './api-memory.js';

// ==================================================================
// 配置（config.json）
// ==================================================================

function createDefaultConfig() {
  return {
    api: {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-3.5-turbo',
      memoryApi: {},
      temperature: 0.8,
      maxTokens: null
    },
    ui: {
      fontSize: 14
    },
    debug: {
      previewBeforeSend: false
    },
    behavior: {
      autoCompleteLastModule: false,
      memoryCorrection: true
    },
    search: {
      enabled: false,
      provider: 'anysearch',
      baseUrl: 'https://api.anysearch.com',
      apiKey: '',
      maxResults: 5
    },
    webdav: {
      enabled: false,
      baseUrl: 'https://dav.jianguoyun.com/dav',
      username: '',
      password: '',
      remoteDir: 'jiuguan',
      deviceName: '',
      lastBackupAt: null,
      lastBackupFileName: null,
      lastRestoreAt: null
    },
    apiProfiles: {}
  };
}

const DEFAULT_SEARCH = {
  enabled: false,
  provider: 'anysearch',
  baseUrl: 'https://api.anysearch.com',
  apiKey: '',
  maxResults: 5
};

const DEFAULT_WEBDAV = {
  enabled: false,
  baseUrl: 'https://dav.jianguoyun.com/dav',
  username: '',
  password: '',
  remoteDir: 'jiuguan',
  deviceName: '',
  lastBackupAt: null,
  lastBackupFileName: null,
  lastRestoreAt: null
};

// 配置迁移步骤表：按顺序原地修补 config；新字段补默认请往表尾加
const CONFIG_STEPS = [
  {
    name: 'ui 默认值',
    migrate(config) {
      if (!config.ui) config.ui = { fontSize: 14 };
      if (config.ui.fontSize === undefined || config.ui.fontSize === null) {
        config.ui.fontSize = 14;
      }
    }
  },
  {
    name: 'search 默认值',
    migrate(config) {
      if (!config.search || typeof config.search !== 'object') {
        config.search = { ...DEFAULT_SEARCH };
      }
    }
  },
  {
    name: 'webdav 默认值与废弃字段',
    migrate(config) {
      if (!config.webdav || typeof config.webdav !== 'object') {
        config.webdav = { ...DEFAULT_WEBDAV };
      }
      if (config.webdav.deviceName === undefined || config.webdav.deviceName === null) {
        config.webdav.deviceName = '';
      }
      if (config.webdav.lastBackupFileName === undefined) {
        config.webdav.lastBackupFileName = null;
      }
      // 废弃 backup-latest 基础文件名配置
      delete config.webdav.fileName;
    }
  },
  {
    name: 'debug 默认值',
    migrate(config) {
      if (!config.debug) config.debug = { previewBeforeSend: false };
      if (config.debug.previewBeforeSend === undefined || config.debug.previewBeforeSend === null) {
        config.debug.previewBeforeSend = false;
      }
    }
  },
  {
    name: 'behavior 默认值与废弃字段',
    migrate(config) {
      if (!config.behavior) config.behavior = { autoCompleteLastModule: false };
      if (config.behavior.autoCompleteLastModule === undefined || config.behavior.autoCompleteLastModule === null) {
        config.behavior.autoCompleteLastModule = false;
      }
      // 记忆修正通道：默认开启（主模型上报记忆矛盾；误报太多可在「其他设置」关闭）
      if (config.behavior.memoryCorrection === undefined || config.behavior.memoryCorrection === null) {
        config.behavior.memoryCorrection = true;
      }
      delete config.behavior.shortTermMemoryMode;
    }
  },
  {
    name: 'apiProfiles 默认值',
    migrate(config) {
      if (!config.apiProfiles) config.apiProfiles = {};
    }
  },
  {
    name: 'api 与副 API（旧 memoryModel 迁移为 memoryApi）',
    migrate(config) {
      if (!config.api) config.api = {};
      // 兼容旧版 memoryModel（同服务商的单独模型）→ 迁移为 memoryApi（可跨服务商的副 API）
      if (!config.api.memoryApi || typeof config.api.memoryApi !== 'object') {
        if (config.api.memoryModel) {
          config.api.memoryApi = {
            baseUrl: config.api.baseUrl || '',
            apiKey: config.api.apiKey || '',
            model: config.api.memoryModel,
            temperature: config.api.temperature,
            maxTokens: config.api.maxTokens
          };
        } else {
          config.api.memoryApi = {};
        }
      }
    }
  }
];

/**
 * 读取配置时调用：null → 完整默认配置；老配置 → 按步骤表补齐到最新结构
 */
export function migrateConfig(raw) {
  const config = (raw && typeof raw === 'object') ? raw : createDefaultConfig();
  for (const step of CONFIG_STEPS) step.migrate(config);
  return config;
}

// ==================================================================
// 会话（chats/{角色}/{会话}.json）
// ==================================================================

// 会话迁移步骤表：合并自原 storage.normalizeChatMemory 与 memory-editor.migrateMemory（两份已去重）
const CHAT_STEPS = [
  {
    name: 'memory 结构',
    migrate(chat) {
      if (!chat.memory || typeof chat.memory !== 'object') {
        chat.memory = { shortTerm: [], longTerm: [], facts: emptyFacts() };
      }
      if (!Array.isArray(chat.memory.shortTerm)) chat.memory.shortTerm = [];
      if (!Array.isArray(chat.memory.longTerm)) chat.memory.longTerm = [];
    }
  },
  {
    name: '原文召回记忆结构',
    migrate(chat) {
      if (!Array.isArray(chat.memory.archive)) chat.memory.archive = [];
      if (!chat.memory.state || typeof chat.memory.state !== 'object') {
        chat.memory.state = { scene: '', characters: [], promises: [], events: [], intel: [], asOfTurn: '', stale: false };
      }
      if (!Array.isArray(chat.memory.recallLog)) chat.memory.recallLog = [];
      if (!chat.memory.engineStartedAt) chat.memory.engineStartedAt = new Date().toISOString();
      chat.memory.engine = 'archive-v1';
    }
  },
  {
    name: 'facts 归一化与旧数据回填',
    migrate(chat) {
      const hadFacts =
        chat.memory.facts &&
        typeof chat.memory.facts === 'object' &&
        ((chat.memory.facts.promises && chat.memory.facts.promises.length) ||
          (chat.memory.facts.relations && chat.memory.facts.relations.length) ||
          (chat.memory.facts.worldEvents && chat.memory.facts.worldEvents.length) ||
          (chat.memory.facts.intel && chat.memory.facts.intel.length));
      chat.memory.facts = normalizeFacts(chat.memory.facts);
      // 旧对话：从已有短期 content 的 ｜世界： 标记回填世界事件（仅 facts 全空时）
      // 注意：promises/relations/intel 都是全量重写语义，此处【不得】传这些字段，否则空数组会清掉现有条目
      if (!hadFacts && chat.memory.shortTerm.length) {
        for (const s of chat.memory.shortTerm) {
          if (s && s.content) applyTurnFactsToMemory(chat.memory, { content: s.content });
        }
      }
    }
  },
  {
    name: '废弃字段清理',
    migrate(chat) {
      const oldLt = chat.memory.longTerm;
      if (oldLt && typeof oldLt === 'object') {
        delete oldLt.relationship;
        delete oldLt.npcStatus;
        delete oldLt.events;
        delete oldLt.playerFacts;
        delete oldLt.characterFacts;
        delete oldLt.custom;
        delete oldLt.stateDerived;
      }
      delete chat.memory.recent;
      delete chat.memory.medium;
      delete chat.memory.shortTermBatchCounter;
      // 生成心跳已改为 .ping 边车文件，清掉旧版会话里残留的字段
      delete chat.generatingPing;
    }
  },
  {
    name: 'roundCounter 补偿',
    migrate(chat) {
      // 缺失时按现有 user 消息数补（幂等），新消息在此基础上 ++；旧消息不逐条标 round
      if (!Number.isFinite(chat.roundCounter)) {
        chat.roundCounter = (chat.messages || []).filter(m => m.role === 'user').length;
      }
    }
  },
  {
    name: 'seedArchive 升级为免费生图记忆（{seed, anchor} 对象）',
    migrate(chat) {
      const sa = chat.seedArchive;
      if (!sa || typeof sa !== 'object') return;
      for (const [name, v] of Object.entries(sa)) {
        if (typeof v === 'number') {
          sa[name] = { seed: v, anchor: '' };
        } else if (v && typeof v === 'object') {
          if (!Number.isFinite(v.seed)) v.seed = 0;
          if (typeof v.anchor !== 'string') v.anchor = '';
        }
      }
    }
  },
  {
    name: 'appearanceAnchors 升级为 {text, img}（锚点支持参考图）',
    migrate(chat) {
      const aa = chat.appearanceAnchors;
      if (!aa || typeof aa !== 'object') return;
      for (const [name, v] of Object.entries(aa)) {
        if (typeof v === 'string') {
          aa[name] = { text: v, img: '' };
        } else if (v && typeof v === 'object') {
          if (typeof v.text !== 'string') v.text = '';
          if (typeof v.img !== 'string') v.img = '';
        }
      }
    }
  }
];

/**
 * 读取/打开会话时调用：按步骤表把老会话补齐到最新结构（幂等，可随读随跑）
 */
export function migrateChat(chat) {
  if (!chat || typeof chat !== 'object') return;
  for (const step of CHAT_STEPS) step.migrate(chat);
}
