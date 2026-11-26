import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isPaidImageProvider,
  isStrictMechanicalProvider,
  imageProviderDisplayName,
  buildOpenAIImageRequestBody,
  generateOpenAIImage,
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
