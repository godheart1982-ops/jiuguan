import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_COMPOSE_SYSTEM_PROMPT,
  STRICT_CINEMATIC_STYLE_SUFFIX,
  STRICT_TEST_SCENARIO_SEEDS,
  hardFilterPrompt,
  prepareFinalTestImagePrompt,
  composeTestIllustrationPrompt,
  prepareIllustrationPrompt,
  generateIllustrationForReply,
  extractNamedAppearanceAnchor
} from '../src/services/image-gen.js';

test('DEFAULT_COMPOSE_SYSTEM_PROMPT and STRICT_CINEMATIC_STYLE_SUFFIX contain required rules', () => {
  assert.match(DEFAULT_COMPOSE_SYSTEM_PROMPT, /真人电影剧照/);
  assert.match(DEFAULT_COMPOSE_SYSTEM_PROMPT, /发型、配饰与衣着规则/);
  assert.match(DEFAULT_COMPOSE_SYSTEM_PROMPT, /保空间、避焦点/);
  assert.match(DEFAULT_COMPOSE_SYSTEM_PROMPT, /光线、色调与电影氛围/);
  assert.match(DEFAULT_COMPOSE_SYSTEM_PROMPT, /一位\{N\}岁女性/);
  assert.match(STRICT_CINEMATIC_STYLE_SUFFIX, /cinematic live-action film still/);
  assert.match(STRICT_CINEMATIC_STYLE_SUFFIX, /35mm film photography/);
  assert.ok(STRICT_TEST_SCENARIO_SEEDS.length >= 6);
});

test('hardFilterPrompt translates legacy risky anchor words in strict mode but preserves them in grok', () => {
  const sample = '一位22岁女性，童颜巨乳，穿着白衬衫站在窗边【私密衣着】';
  const strictFiltered = hardFilterPrompt(sample, 'openai');
  assert.ok(strictFiltered.includes('面容清秀显年轻'));
  assert.ok(strictFiltered.includes('身材丰满'));
  assert.ok(!strictFiltered.includes('童颜'));
  assert.ok(!strictFiltered.includes('巨乳'));

  const grokFiltered = hardFilterPrompt(sample, 'grok');
  assert.ok(grokFiltered.includes('童颜'));
  assert.ok(grokFiltered.includes('巨乳'));
});

test('prepareFinalTestImagePrompt filters risky words and avoids duplicate style suffix', () => {
  const first = prepareFinalTestImagePrompt('一位25岁女性，童颜，倚在窗边【私密衣着】', 'openai');
  assert.ok(first.includes('面容清秀显年轻'));
  assert.ok(!first.includes('私密衣着'));
  assert.ok(first.endsWith(STRICT_CINEMATIC_STYLE_SUFFIX));

  const second = prepareFinalTestImagePrompt(first, 'openai');
  assert.equal(second, first);

  const grokOut = prepareFinalTestImagePrompt('一位25岁女性倚在床边', 'grok');
  assert.match(grokOut, /strictly photorealistic real photograph/);
});

function setupMockStorage(t) {
  const origWindow = globalThis.window;
  globalThis.window = {
    electronAPI: {
      fs: {
        readFile: async () => null,
        writeFile: async () => true
      }
    }
  };
  t.after(() => { globalThis.window = origWindow; });
}

test('composeTestIllustrationPrompt routes to memoryApi (sub API) and cleans quotes', async (t) => {
  setupMockStorage(t);
  const origFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = origFetch; });

  let calledUrl = '';
  let calledModel = '';
  globalThis.fetch = async (url, init) => {
    calledUrl = url;
    const body = JSON.parse(init.body);
    calledModel = body.model;
    return {
      ok: true,
      async json() {
        return {
          choices: [{ message: { content: '「一位27岁女性穿着米白羊绒衫站在雨夜咖啡馆窗边，暖黄灯光映在玻璃上。」' } }]
        };
      }
    };
  };

  const res = await composeTestIllustrationPrompt({
    provider: 'openai',
    apiConfig: {
      baseUrl: 'https://main.example.com/v1',
      apiKey: 'main-key',
      model: 'main-model',
      memoryApi: {
        baseUrl: 'https://sub.example.com/v1',
        apiKey: 'sub-key',
        model: 'sub-model'
      }
    },
    scenario: STRICT_TEST_SCENARIO_SEEDS[0]
  });

  assert.equal(calledUrl, 'https://sub.example.com/v1/chat/completions');
  assert.equal(calledModel, 'sub-model');
  assert.equal(res.scenarioLabel, STRICT_TEST_SCENARIO_SEEDS[0].label);
  assert.equal(res.prompt, '一位27岁女性穿着米白羊绒衫站在雨夜咖啡馆窗边，暖黄灯光映在玻璃上。');
});

test('prepareIllustrationPrompt & generateIllustrationForReply strict pipeline supports L0, L1 retry, and L2 fallback', async (t) => {
  setupMockStorage(t);
  const origFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = origFetch; });

  const baseConfig = {
    api: {
      baseUrl: 'https://sub.example.com/v1',
      apiKey: 'sub-key',
      model: 'sub-model'
    },
    image: {
      provider: 'openai',
      openai: {
        baseUrl: 'https://img.example.com/v1',
        apiKey: 'img-key',
        model: 'gpt-image-1'
      }
    }
  };
  const character = { id: 'c1', name: '林晚', modules: [] };
  const anchors = { 林晚: { text: '一位26岁女性，鹅蛋脸，齐肩黑发，身材高挑匀称。', img: '' } };

  // 1) prepareIllustrationPrompt (L0)
  let capturedSystem = '';
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body?.messages?.[0]?.role === 'system') {
      capturedSystem = body.messages[0].content;
    }
    return {
      ok: true,
      async json() {
        return {
          choices: [{ message: { content: '穿着黑色针织衫倚在窗边，窗外细雨与琥珀色台灯交织。' } }]
        };
      }
    };
  };
  const prepared = await prepareIllustrationPrompt({
    replyContent: '她站在窗边看雨。',
    character,
    config: baseConfig,
    anchorName: '林晚',
    anchors
  });
  assert.match(capturedSystem, /务必主动描写当前发型与配饰/);
  assert.ok(prepared.prompt.startsWith('一位26岁女性，鹅蛋脸，齐肩黑发，身材高挑匀称，'));
  assert.ok(prepared.prompt.includes('窗外细雨与琥珀色台灯交织'));
  assert.ok(prepared.prompt.endsWith(STRICT_CINEMATIC_STYLE_SUFFIX));

  // 2) generateIllustrationForReply L1 moderation retry -> succeeds on attempt 1
  let imgCalls = 0;
  let chatCalls = 0;
  globalThis.fetch = async (url) => {
    if (url.endsWith('/chat/completions')) {
      chatCalls++;
      return {
        ok: true,
        async json() {
          return {
            choices: [{
              message: {
                content: chatCalls === 1
                  ? '穿着丝绸衬衫靠在窗边，神情略带倦意，暖黄灯光洒满房间。'
                  : '穿着宽松棉质衬衫站在窗边，神情柔和，暖黄灯光映在木桌与窗帘上。'
              }
            }]
          };
        }
      };
    }
    imgCalls++;
    if (imgCalls === 1) {
      return {
        ok: false,
        status: 400,
        async text() {
          return JSON.stringify({ error: { message: 'content_policy_violation' } });
        }
      };
    }
    return {
      ok: true,
      async json() {
        return { data: [{ b64_json: 'QUJD' }] };
      }
    };
  };

  const retried = await generateIllustrationForReply({
    replyContent: '她在房间里看着窗外。',
    character,
    config: baseConfig,
    anchorName: '林晚',
    anchors
  });
  assert.equal(imgCalls, 2);
  assert.equal(chatCalls, 2);
  assert.equal(retried.dataUrl, 'data:image/png;base64,QUJD');
  assert.ok(retried.prompt.includes('宽松棉质衬衫'));

  // 3) generateIllustrationForReply L2 portrait fallback when L0 and L1 both hit moderation
  let imgCallsL2 = 0;
  globalThis.fetch = async (url) => {
    if (url.endsWith('/chat/completions')) {
      return {
        ok: true,
        async json() {
          return {
            choices: [{ message: { content: '穿着真丝吊带站在卧室窗边，昏暗灯光。' } }]
          };
        }
      };
    }
    imgCallsL2++;
    if (imgCallsL2 < 3) {
      return {
        ok: false,
        status: 400,
        async text() {
          return JSON.stringify({ error: { message: 'safety system rejected' } });
        }
      };
    }
    return {
      ok: true,
      async json() {
        return { data: [{ b64_json: 'REVG' }] };
      }
    };
  };

  const fallbackRes = await generateIllustrationForReply({
    replyContent: '她在卧室。',
    character,
    config: baseConfig,
    anchorName: '林晚',
    anchors
  });
  assert.equal(imgCallsL2, 3);
  assert.ok(fallbackRes.prompt.includes('单人半身肖像'));
  assert.equal(fallbackRes.dataUrl, 'data:image/png;base64,REVG');
});

test('composeTestIllustrationPrompt and extractNamedAppearanceAnchor skip facial features when hasRefImage=true', async (t) => {
  setupMockStorage(t);
  const origFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = origFetch; });

  const capturedSystems = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    capturedSystems.push(body?.messages?.[0]?.content || '');
    return {
      ok: true,
      async json() {
        return { choices: [{ message: { content: '一位27岁女性，身材高挑纤细。' } }] };
      }
    };
  };

  await composeTestIllustrationPrompt({
    provider: 'openai',
    apiConfig: { baseUrl: 'https://sub.example.com/v1', apiKey: 'sub-key', model: 'sub-model' },
    scenario: STRICT_TEST_SCENARIO_SEEDS[0],
    hasRefImage: true
  });
  assert.ok(capturedSystems[0].includes('面部参考图模式·严禁写五官'));
  assert.ok(!capturedSystems[0].includes('深棕眼眸'));
  assert.ok(capturedSystems[0].includes('身材高挑纤细'));

  await extractNamedAppearanceAnchor({
    name: '林晚',
    replyContent: '她站在窗边。',
    character: { id: 'c1', name: '林晚', modules: [] },
    apiConfig: { baseUrl: 'https://sub.example.com/v1', apiKey: 'sub-key', model: 'sub-model' },
    hasRefImage: true
  });
  assert.ok(capturedSystems[1].includes('已有面部外貌参考图'));
  assert.ok(capturedSystems[1].includes('【绝对禁止】描写任何脸型、五官、眉眼鼻唇'));
});
