/**
 * LLM 客户端：阿里云百炼（DashScope）OpenAI 兼容模式。
 *
 * 纪律（对应设计 §11）：
 *  - 参数全部来自冻结配置（temperature/topP/maxTokens/enableThinking），调用方不得临时改；
 *  - 失败重试 4 次（指数退避 + Retry-After），重试仍失败则抛错，由 runner 记录为失败样本，
 *    禁止静默丢弃；
 *  - 每次调用回传 usage 与 latency，落盘留痕（成本与延迟可审计）；
 *  - API key 只从参数或环境变量 DASHSCOPE_API_KEY 读取，绝不写入仓库文件。
 *
 * 术语：本文件不依赖任何第三方 SDK，使用 Node ≥18 内置 fetch。
 */
'use strict';

const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const NOT_CONFIGURED =
  'LLM 客户端尚未配置（generator.model 为 null）。请在配置中填写 model 并设置 DASHSCOPE_API_KEY。';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} cfg 冻结配置的 generator 段（model/temperature/topP/maxTokens/provider）
 * @param {object} [opts] { apiKey, baseUrl, timeoutMs, maxRetries, fetchImpl }
 */
function createLlmClient(cfg = {}, opts = {}) {
  const model = cfg.model || null;
  const apiKey = opts.apiKey || process.env.DASHSCOPE_API_KEY || null;
  const baseUrl = (opts.baseUrl || cfg.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const maxRetries = opts.maxRetries ?? 4;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const enableThinking = cfg.enableThinking ?? false;

  if (!model || !apiKey) {
    return {
      model,
      configured: false,
      complete: async () => { throw new Error(NOT_CONFIGURED); },
    };
  }

  /**
   * @param {string|Array} prompt 字符串（单轮）或 messages 数组
   * @param {object} [over] 仅允许覆盖采样参数做 pilot，正式运行不得传
   * @returns {Promise<{text, finishReason, usage, latencyMs, attempts}>}
   */
  async function complete(prompt, over = {}) {
    const messages = typeof prompt === 'string' ? [{ role: 'user', content: prompt }] : prompt;
    const body = {
      model,
      messages,
      temperature: over.temperature ?? cfg.temperature ?? 0,
      top_p: over.topP ?? cfg.topP ?? 1,
      max_tokens: over.maxTokens ?? cfg.maxTokens ?? 512,
      enable_thinking: over.enableThinking ?? enableThinking,
    };
    let lastErr = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const t0 = Date.now();
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
        const raw = await res.text();
        let json = null;
        try { json = JSON.parse(raw); } catch { /* 非 JSON 响应按错误处理 */ }
        if (!res.ok) {
          const msg = json?.error?.message || raw.slice(0, 300);
          const err = new Error(`HTTP ${res.status}: ${msg}`);
          err.status = res.status;
          err.retryable = res.status === 429 || res.status >= 500;
          err.retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
          throw err;
        }
        const choice = json?.choices?.[0];
        if (!choice) throw new Error(`响应缺少 choices：${raw.slice(0, 200)}`);
        return {
          text: String(choice.message?.content ?? ''),
          finishReason: choice.finish_reason ?? null,
          usage: json.usage ?? null,
          latencyMs: Date.now() - t0,
          attempts: attempt,
          model: json.model || model,
        };
      } catch (e) {
        lastErr = e;
        const retryable = e.retryable ?? (e.name === 'AbortError' || e.name === 'TypeError' || e.code === 'ECONNRESET');
        if (attempt >= maxRetries || !retryable) break;
        const backoff = e.retryAfterMs ?? Math.min(8000, 500 * 2 ** (attempt - 1));
        await sleep(backoff + Math.floor(Math.random() * 250));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  return { model, configured: true, complete };
}

function parseRetryAfter(v) {
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.min(30_000, Math.max(0, n * 1000));
  const d = Date.parse(v);
  return Number.isFinite(d) ? Math.min(30_000, Math.max(0, d - Date.now())) : undefined;
}

module.exports = { createLlmClient, DEFAULT_BASE_URL, NOT_CONFIGURED };
