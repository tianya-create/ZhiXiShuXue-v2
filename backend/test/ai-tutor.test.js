const {
  validateQuestion,
  isJuniorMathRelated,
  isProblemSolvingRequest,
  sanitizeTutorReply,
  encryptSecret,
  decryptSecret,
  getTutorConfig,
  normalizeTutorMode
} = require('../services/ai-tutor')

describe('ai tutor question validation', () => {
  test('accepts junior math question in problem mode', () => {
    const result = validateQuestion('一元一次方程 2x+3=7 应该怎么思考？', 'problem')
    expect(result.valid).toBe(true)
  })

  test('accepts short math chat in chat mode', () => {
    const result = validateQuestion('函数', 'chat')
    expect(result.valid).toBe(true)
  })

  test('accepts natural math conversation in chat mode', () => {
    const result = validateQuestion('我最近总学不会函数，怎么办', 'chat')
    expect(result.valid).toBe(true)
  })

  test('rejects non math question in chat mode', () => {
    const result = validateQuestion('帮我写一篇语文作文', 'chat')
    expect(result.valid).toBe(false)
  })

  test('rejects non math content in problem mode', () => {
    const result = validateQuestion('你今天心情怎么样', 'problem')
    expect(result.valid).toBe(false)
  })

  test('normalizes tutor mode', () => {
    expect(normalizeTutorMode('problem')).toBe('problem')
    expect(normalizeTutorMode('chat')).toBe('chat')
    expect(normalizeTutorMode('other')).toBe('chat')
  })

  test('detects junior math content', () => {
    expect(isJuniorMathRelated('勾股定理题目该如何分析')).toBe(true)
    expect(isJuniorMathRelated('推荐一部电影')).toBe(false)
  })
})

describe('ai tutor answer policy', () => {
  test('marks problem solving requests', () => {
    expect(isProblemSolvingRequest('这道方程题答案是多少')).toBe(true)
    expect(isProblemSolvingRequest('什么是一元一次方程')).toBe(false)
  })

  test('sanitizes direct answer style output', () => {
    const output = sanitizeTutorReply('答案：A', true)
    expect(output.includes('答案')).toBe(false)
    expect(output.includes('思路提示')).toBe(true)
  })
})

describe('ai tutor key encryption', () => {
  test('encrypts and decrypts api key', () => {
    const raw = 'sk-test-123456'
    const encrypted = encryptSecret(raw)
    expect(encrypted).not.toBe(raw)
    expect(decryptSecret(encrypted)).toBe(raw)
  })

  test('prefers environment config when present', () => {
    var oldEndpoint = process.env.AI_TUTOR_API_ENDPOINT
    var oldModel = process.env.AI_TUTOR_MODEL
    var oldKey = process.env.AI_TUTOR_API_KEY
    process.env.AI_TUTOR_API_ENDPOINT = 'https://example.com/v1/chat/completions'
    process.env.AI_TUTOR_MODEL = 'qwen-test'
    process.env.AI_TUTOR_API_KEY = 'sk-env-test'

    const config = getTutorConfig()
    expect(config.endpoint).toBe('https://example.com/v1/chat/completions')
    expect(config.model).toBe('qwen-test')
    expect(config.apiKey).toBe('sk-env-test')
    expect(config.managedByEnv).toBe(true)

    process.env.AI_TUTOR_API_ENDPOINT = oldEndpoint
    process.env.AI_TUTOR_MODEL = oldModel
    process.env.AI_TUTOR_API_KEY = oldKey
  })
})
