const router = require('../routes/ai-tutor-admin')

function getSettingsHandlerStack() {
  return router.stack
}

function runMiddleware(layer, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code
        return this
      },
      json(payload) {
        this.body = payload
        resolve({ statusCode: this.statusCode, body: this.body })
      }
    }

    layer.handle(req, res, function next() {
      resolve({ statusCode: res.statusCode, body: res.body, nextCalled: true, req: req })
    })
  })
}

describe('ai tutor admin authorization', () => {
  test('rejects request without user id', async () => {
    const middlewareLayer = getSettingsHandlerStack()[0]
    const result = await runMiddleware(middlewareLayer, { headers: {} })
    expect(result.statusCode).toBe(401)
  })

  test('rejects non-admin user', async () => {
    const middlewareLayer = getSettingsHandlerStack()[0]
    const result = await runMiddleware(middlewareLayer, { headers: { 'x-user-id': 'student-001' } })
    expect(result.statusCode).toBe(403)
  })

  test('allows admin user to pass middleware', async () => {
    const middlewareLayer = getSettingsHandlerStack()[0]
    const req = { headers: { 'x-user-id': 'admin-001' } }
    const result = await runMiddleware(middlewareLayer, req)
    expect(result.nextCalled).toBe(true)
    expect(result.req.currentUser.role).toBe('admin')
  })
})
