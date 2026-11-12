'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createLlmClient, NOT_CONFIGURED } = require('../src/llm/llmClient');

const CFG = { model: 'test-model', temperature: 0, topP: 1, maxTokens: 64, enableThinking: false };

function mockFetch(handlers) {
  let i = 0;
  return async (url, init) => {
    const h = handlers[Math.min(i, handlers.length - 1)];
    i += 1;
    return h(url, init);
  };
}
const okResponse = (content = '2') => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  text: async () => JSON.stringify({ model: 'test-model', choices: [{ message: { content }, finish_reason: 'stop' }], usage: { total_tokens: 10 } }),
});
const errResponse = (status, retryAfter = null) => ({
  ok: false,
  status,
  headers: { get: (k) => (k.toLowerCase() === 'retry-after' ? retryAfter : null) },
  text: async () => JSON.stringify({ error: { message: 'boom' } }),
});

test('未配置时抛错而不是返回估计值', async () => {
  const c = createLlmClient({ model: null }, { apiKey: 'k' });
  assert.strictEqual(c.configured, false);
  await assert.rejects(() => c.complete('hi'), new RegExp(NOT_CONFIGURED.slice(0, 12)));
});

test('缺 api key 时也视为未配置', () => {
  const c = createLlmClient(CFG, { apiKey: '', fetchImpl: mockFetch([okResponse]) });
  assert.strictEqual(c.configured, false);
});

test('正常返回 content/usage/finishReason，请求体带冻结参数', async () => {
  let seen = null;
  const fetchImpl = async (url, init) => { seen = { url, init }; return okResponse('42'); };
  const c = createLlmClient(CFG, { apiKey: 'k', fetchImpl });
  const r = await c.complete('问题');
  assert.strictEqual(r.text, '42');
  assert.strictEqual(r.finishReason, 'stop');
  assert.deepStrictEqual(r.usage, { total_tokens: 10 });
  const body = JSON.parse(seen.init.body);
  assert.strictEqual(body.model, 'test-model');
  assert.strictEqual(body.temperature, 0);
  assert.strictEqual(body.enable_thinking, false);
  assert.match(seen.url, /\/chat\/completions$/);
  assert.strictEqual(seen.init.headers.Authorization, 'Bearer k');
});

test('429 会重试并最终成功', async () => {
  const fetchImpl = mockFetch([() => errResponse(429, '0'), () => errResponse(429, '0'), () => okResponse('ok')]);
  const c = createLlmClient(CFG, { apiKey: 'k', fetchImpl, maxRetries: 4 });
  const r = await c.complete('q');
  assert.strictEqual(r.text, 'ok');
  assert.strictEqual(r.attempts, 3);
});

test('4xx 不可重试：立即失败', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return errResponse(400); };
  const c = createLlmClient(CFG, { apiKey: 'k', fetchImpl, maxRetries: 4 });
  await assert.rejects(() => c.complete('q'), /HTTP 400/);
  assert.strictEqual(calls, 1);
});

test('重试耗尽后抛错（不返回空串冒充成功）', async () => {
  const fetchImpl = async () => errResponse(500);
  const c = createLlmClient(CFG, { apiKey: 'k', fetchImpl, maxRetries: 2 });
  await assert.rejects(() => c.complete('q'), /HTTP 500/);
});

test('响应缺 choices 视为失败', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({}) });
  const c = createLlmClient(CFG, { apiKey: 'k', fetchImpl, maxRetries: 1 });
  await assert.rejects(() => c.complete('q'), /缺少 choices/);
});
