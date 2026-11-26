import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isPaidImageProvider,
  isStrictMechanicalProvider,
  imageProviderDisplayName,
  buildOpenAIImageRequestBody,
  buildOpenAIImageEditFormData,
  buildGrokImageRequestBody,
  OPENAI_REF_IMAGE_PROMPT_PREFIX,
  generateOpenAIImage,
  generateGrokImage,
  fetchOpenAIModels
} from '../src/services/image-gen.js';
import { isModerationError } from '../src/services/image-gen/providers.js';

test('openai provider metadata and strict moderation detection', () => {
  assert.equal(isPaidImageProvider('openai'), true);
  assert.equal(isStrictMechanicalProvider('openai'), true);
  assert.equal(imageProviderDisplayName('openai'), 'OpenAI 生图');
  assert.equal(
    isModerationError(new Error('OpenAI 生图失败 (400): Your request was rejected as a result of our safety system (content_policy_violation).')),
    true
  );
  assert.equal(isModerationError(new Error('OpenAI 生图失败 (401): Incorrect API key')), false);
});

test('buildOpenAIImageRequestBody handles gpt-image vs dall-e and auto options', () => {
  assert.deepEqual(
    buildOpenAIImageRequestBody({
      model: 'gpt-image-1',
      prompt: 'a portrait',
      size: '1024x1536',
      quality: 'auto'
    }),
    {
      model: 'gpt-image-1',
      prompt: 'a portrait',
      n: 1,
      size: '1024x1536'
    }
  );

  assert.deepEqual(
    buildOpenAIImageRequestBody({
      model: 'dall-e-3',
      prompt: 'a landscape',
      size: 'auto',
      quality: 'hd'
    }),
    {
      model: 'dall-e-3',
      prompt: 'a landscape',
      n: 1,
      quality: 'hd',
      response_format: 'b64_json'
    }
  );
});

test('generateOpenAIImage handles b64_json, output_format, url fallback, and errors', async (t) => {
  const origFetch = globalThis.fetch;
  const origFileReader = globalThis.FileReader;
  t.after(() => {
    globalThis.fetch = origFetch;
    globalThis.FileReader = origFileReader;
  });

  await assert.rejects(
    () => generateOpenAIImage({ baseUrl: 'https://api.openai.com/v1', apiKey: '', prompt: 'hi' }),
    /API Key/
  );

  // b64_json + output_format=jpg -> image/jpeg
  let capturedUrl = '';
  let capturedBody = null;
  globalThis.fetch = async (url, init) => {
    capturedUrl = url;
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      async json() {
        return {
          output_format: 'jpg',
          data: [{ b64_json: 'QUJD' }]
        };
      }
    };
  };

  const dataUrl = await generateOpenAIImage({
    baseUrl: 'https://relay.example.com/v1/',
    apiKey: 'sk-test',
    model: 'gpt-image-1',
    size: '1024x1536',
    quality: 'medium',
    prompt: 'test prompt'
  });
  assert.equal(capturedUrl, 'https://relay.example.com/v1/images/generations');
  assert.equal(capturedBody.model, 'gpt-image-1');
  assert.equal(capturedBody.response_format, undefined);
  assert.equal(dataUrl, 'data:image/jpeg;base64,QUJD');

  // url fallback -> fetchUrlAsDataUrl
  globalThis.FileReader = class {
    readAsDataURL() {
      this.result = 'data:image/png;base64,AQID';
      this.onload?.();
    }
  };
  globalThis.fetch = async (url) => {
    if (url.endsWith('/images/generations')) {
      return {
        ok: true,
        async json() {
          return { data: [{ url: 'https://cdn.example.com/img.png' }] };
        }
      };
    }
    return {
      ok: true,
      async blob() {
        return { type: 'image/png' };
      }
    };
  };
  const fromUrl = await generateOpenAIImage({
    baseUrl: 'https://api.openai.com/v1/images/generations',
    apiKey: 'sk-test',
    model: 'dall-e-3',
    prompt: 'test url'
  });
  assert.equal(fromUrl, 'data:image/png;base64,AQID');

  // HTTP error
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    async text() {
      return JSON.stringify({ error: { message: 'content_policy_violation' } });
    }
  });
  await assert.rejects(
    () => generateOpenAIImage({ apiKey: 'sk-test', prompt: 'blocked' }),
    /OpenAI 生图失败 \(400\): content_policy_violation/
  );
});

test('fetchOpenAIModels fetches, deduplicates, sorts image models first, and handles errors', async (t) => {
  const origFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = origFetch; });

  await assert.rejects(
    () => fetchOpenAIModels({ baseUrl: 'https://api.openai.com/v1', apiKey: '' }),
    /API Key/
  );

  let requestedUrl = '';
  let authHeader = '';
  globalThis.fetch = async (url, init) => {
    requestedUrl = url;
    authHeader = init.headers.Authorization;
    return {
      ok: true,
      async json() {
        return {
          data: [
            { id: 'gpt-4o' },
            { id: 'dall-e-3' },
            { id: 'gpt-image-1' },
            { id: 'gpt-image-1' },
            { id: 'flux-pro' },
            { id: 'claude-3-7-sonnet' }
          ]
        };
      }
    };
  };

  const result = await fetchOpenAIModels({
    baseUrl: 'https://relay.example.com/v1/images/generations',
    apiKey: 'sk-models'
  });
  assert.equal(requestedUrl, 'https://relay.example.com/v1/models');
  assert.equal(authHeader, 'Bearer sk-models');
  assert.deepEqual(result.imageLikely, ['dall-e-3', 'flux-pro', 'gpt-image-1']);
  assert.deepEqual(result.all, ['dall-e-3', 'flux-pro', 'gpt-image-1', 'claude-3-7-sonnet', 'gpt-4o']);

  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    async text() {
      return JSON.stringify({ error: { message: 'Invalid API key' } });
    }
  });
  await assert.rejects(
    () => fetchOpenAIModels({ baseUrl: 'https://api.openai.com/v1', apiKey: 'bad' }),
    /获取模型失败 \(401\): Invalid API key/
  );
});

test('buildOpenAIImageEditFormData and generateOpenAIImage reference image flow', async (t) => {
  const origFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = origFetch; });

  const sampleImg = 'data:image/jpeg;base64,QUJD';
  const fd = buildOpenAIImageEditFormData({
    model: 'gpt-image-1',
    prompt: '雨夜咖啡馆窗边',
    size: '1024x1536',
    quality: 'auto',
    images: [sampleImg]
  });
  assert.equal(fd.get('model'), 'gpt-image-1');
  assert.equal(fd.get('input_fidelity'), 'high');
  assert.equal(fd.get('size'), '1024x1536');
  assert.equal(fd.get('quality'), null);
  assert.match(OPENAI_REF_IMAGE_PROMPT_PREFIX, /Use the exact woman's face/);
  assert.match(OPENAI_REF_IMAGE_PROMPT_PREFIX, /not a collage/);
  assert.ok(String(fd.get('prompt')).startsWith(OPENAI_REF_IMAGE_PROMPT_PREFIX));
  assert.ok(fd.get('image') instanceof Blob);

  const fdLow = buildOpenAIImageEditFormData({
    model: 'gpt-image-1',
    prompt: '雨夜咖啡馆窗边',
    inputFidelity: 'low',
    images: [sampleImg]
  });
  assert.equal(fdLow.get('input_fidelity'), 'low');

  // 1) gpt-image-1 with ref image -> /images/edits; 400 on input_fidelity retries without it
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: init.body });
    if (calls.length === 1) {
      return {
        ok: false,
        status: 400,
        async text() {
          return JSON.stringify({ error: { message: 'Unknown parameter: input_fidelity' } });
        }
      };
    }
    return {
      ok: true,
      async json() {
        return { data: [{ b64_json: 'RUVG' }] };
      }
    };
  };

  let capturedMeta = null;
  const out = await generateOpenAIImage({
    baseUrl: 'https://relay.example.com/v1/images/generations',
    apiKey: 'sk-ref',
    model: 'gpt-image-1',
    prompt: '窗边咖啡馆',
    images: [sampleImg],
    onMeta: (m) => { capturedMeta = m; }
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://relay.example.com/v1/images/edits');
  assert.equal(calls[0].body.get('input_fidelity'), 'high');
  assert.equal(calls[1].url, 'https://relay.example.com/v1/images/edits');
  assert.equal(calls[1].body.get('input_fidelity'), null);
  assert.deepEqual(capturedMeta, { mode: 'edits', inputFidelity: null, downgraded: true });
  assert.equal(out, 'data:image/png;base64,RUVG');

  // 2) dall-e-3 ignores ref images and uses /images/generations
  let dalleUrl = '';
  let dalleMeta = null;
  globalThis.fetch = async (url) => {
    dalleUrl = url;
    return {
      ok: true,
      async json() {
        return { data: [{ b64_json: 'REFM' }] };
      }
    };
  };
  const dalleOut = await generateOpenAIImage({
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-ref',
    model: 'dall-e-3',
    prompt: '窗边咖啡馆',
    images: [sampleImg],
    onMeta: (m) => { dalleMeta = m; }
  });
  assert.equal(dalleUrl, 'https://api.openai.com/v1/images/generations');
  assert.deepEqual(dalleMeta, { mode: 'generations', skippedRefImage: true });
  assert.equal(dalleOut, 'data:image/png;base64,REFM');
});

test('buildGrokImageRequestBody and generateGrokImage support JSON /images/edits and /images/generations', async (t) => {
  const origFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = origFetch; });

  const img1 = 'data:image/jpeg;base64,QUJD';
  const img2 = 'data:image/png;base64,REVG';

  const gen = buildGrokImageRequestBody({ model: 'grok-imagine-image', prompt: '雨夜街头', aspectRatio: '9:16', resolution: '1k' });
  assert.equal(gen.isEdit, false);
  assert.equal(gen.body.image, undefined);
  assert.equal(gen.body.images, undefined);
  assert.equal(gen.body.prompt, '雨夜街头');

  const editOne = buildGrokImageRequestBody({ model: 'grok-imagine-image-2.0', prompt: '窗边咖啡馆', images: [img1] });
  assert.equal(editOne.isEdit, true);
  assert.deepEqual(editOne.body.image, { url: img1, type: 'image_url' });
  assert.equal(editOne.body.images, undefined);
  assert.ok(editOne.body.prompt.startsWith(OPENAI_REF_IMAGE_PROMPT_PREFIX));

  const editTwo = buildGrokImageRequestBody({ model: 'grok-imagine-image-2.0', prompt: '窗边咖啡馆', images: [img1, img2] });
  assert.equal(editTwo.isEdit, true);
  assert.equal(editTwo.body.image, undefined);
  assert.deepEqual(editTwo.body.images, [
    { url: img1, type: 'image_url' },
    { url: img2, type: 'image_url' }
  ]);

  const captured = [];
  globalThis.fetch = async (url, init) => {
    captured.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      async json() {
        return { data: [{ b64_json: 'R1JPSw==' }] };
      }
    };
  };

  let metaEdit = null;
  const outEdit = await generateGrokImage({
    baseUrl: 'https://api.x.ai/v1/images/generations',
    apiKey: 'xai-test',
    model: 'grok-imagine-image-2.0',
    aspectRatio: '9:16',
    resolution: '2k',
    prompt: '窗边咖啡馆',
    images: [img1],
    onMeta: (m) => { metaEdit = m; }
  });
  assert.equal(captured[0].url, 'https://api.x.ai/v1/images/edits');
  assert.deepEqual(captured[0].body.image, { url: img1, type: 'image_url' });
  assert.equal(captured[0].body.aspect_ratio, '9:16');
  assert.equal(captured[0].body.resolution, '2k');
  assert.deepEqual(metaEdit, { mode: 'edits' });
  assert.equal(outEdit, 'data:image/png;base64,R1JPSw==');

  let metaGen = null;
  await generateGrokImage({
    baseUrl: 'https://api.x.ai/v1/',
    apiKey: 'xai-test',
    prompt: '纯文生图',
    onMeta: (m) => { metaGen = m; }
  });
  assert.equal(captured[1].url, 'https://api.x.ai/v1/images/generations');
  assert.deepEqual(metaGen, { mode: 'generations' });
});
