#!/usr/bin/env node
/**
 * 通过 GitHub REST API 逐 commit 推送（git push 被网络代理拦截时的备用通道）。
 * 用法: node scripts/push-via-api.js <remote-owner/repo> <branch> <commit1> <commit2> ...
 * 复刻每个 commit 的 author/committer/日期/message 与 tree，使远端 hash 与本地一致。
 */
const { execSync, execFileSync } = require('child_process')
const path = require('path')

const repo = process.argv[2]
const branch = process.argv[3]
const commits = process.argv.slice(4)
if (!repo || !branch || !commits.length) {
  console.error('用法: node scripts/push-via-api.js <owner/repo> <branch> <commit...>')
  process.exit(1)
}

function credentialToken() {
  const out = execSync('git credential fill', {
    input: 'protocol=https\nhost=github.com\n',
    encoding: 'utf8',
    cwd: path.join(__dirname, '..')
  })
  const m = out.match(/^password=(.+)$/m)
  if (!m) throw new Error('未找到 github.com 凭证')
  return m[1].trim()
}

const TOKEN = credentialToken()

// 通过 curl 调用 GitHub API（Node 直连与 CONNECT 隧道均被间歇性 TLS 断连，
// 而 curl 走系统代理稳定可用）；自动继承 http_proxy/https_proxy 环境变量
function api(method, urlPath, body) {
  const args = [
    '-sS', '--max-time', '180', '--retry', '3', '--retry-delay', '2',
    '-X', method,
    '-H', 'Authorization: Bearer ' + TOKEN,
    '-H', 'User-Agent: push-via-api',
    '-H', 'Accept: application/vnd.github+json',
    ...(body ? ['-H', 'Content-Type: application/json', '--data-binary', '@-'] : []),
    'https://api.github.com' + urlPath
  ]
  const out = execFileSync('curl', args, {
    input: body ? JSON.stringify(body) : undefined,
    encoding: 'utf8',
    maxBuffer: 1 << 26
  })
  const json = out ? JSON.parse(out) : {}
  // GitHub 的 commit 创建成功响应也含 message 字段，只有「有 message 且无 sha」才是错误
  if (json.message && !json.sha && !json.object) throw new Error(`${method} ${urlPath} → ${json.message}`)
  return json
}

const git = (args, opts = {}) => execSync(`git -c core.quotepath=off ${args}`, { encoding: 'utf8', cwd: path.join(__dirname, '..'), maxBuffer: 1 << 28, ...opts })

async function main() {
  const ref = await api('GET', `/repos/${repo}/git/ref/heads/${branch}`)
  let parentSha = ref.object.sha
  console.log(`远端 ${branch} = ${parentSha}`)

  for (const shortSha of commits) {
    const sha = git(`rev-parse ${shortSha}`).trim()
    const raw = git(`cat-file commit ${sha}`)
    const treeLocal = raw.match(/^tree ([0-9a-f]{40})$/m)[1]
    const authorM = raw.match(/^author (.+)$/m)[1]
    const committerM = raw.match(/^committer (.+)$/m)[1]
    const message = raw.slice(raw.indexOf('\n\n') + 2)
    if (!raw.includes(`parent ${parentSha}`)) {
      throw new Error(`${sha} 的本地 parent 与远端进度不一致（远端=${parentSha}）`)
    }
    // 变更文件列表（相对 parent）
    const diffOut = git(`diff-tree -r --no-commit-id --name-status ${parentSha} ${sha}`)
    const entries = []
    for (const line of diffOut.trim().split('\n').filter(Boolean)) {
      const [status, ...rest] = line.split('\t')
      const filePath = rest.join('\t')
      if (status === 'D') {
        entries.push({ path: filePath, mode: '100644', type: 'blob', sha: null })
        continue
      }
      const ls = git(`ls-tree ${sha} -- "${filePath}"`).trim()
      const mode = ls.split(' ')[0]
      const content = git(`show ${sha}:"${filePath}"`, { encoding: 'buffer' })
      const blob = await api('POST', `/repos/${repo}/git/blobs`, {
        content: content.toString('base64'),
        encoding: 'base64'
      })
      entries.push({ path: filePath, mode, type: 'blob', sha: blob.sha })
      console.log(`  blob ${filePath} (${content.length} B)`)
    }
    const tree = await api('POST', `/repos/${repo}/git/trees`, { base_tree: parentSha, tree: entries })
    if (tree.sha !== treeLocal) throw new Error(`${sha} 远端 tree ${tree.sha} != 本地 ${treeLocal}`)
    const parseId = (line) => {
      const m = line.match(/^(.+) <(.+)> (\d+) ([+-])(\d{2})(\d{2})$/)
      // git 时间戳为 unix 秒 + 数字时区；API 需要 ISO8601。
      // 先按该时区的本地时间换算出同一瞬时的 UTC 时间，再附加时区后缀，保证瞬时点不变
      const sign = m[4] === '-' ? -1 : 1
      const offsetSec = sign * (Number(m[5]) * 3600 + Number(m[6]) * 60)
      const date = new Date((Number(m[3]) + offsetSec) * 1000).toISOString().replace('.000Z', '') + `${m[4]}${m[5]}:${m[6]}`
      return { name: m[1], email: m[2], date }
    }
    const commit = await api('POST', `/repos/${repo}/git/commits`, {
      message,
      tree: tree.sha,
      parents: [parentSha],
      author: parseId(authorM),
      committer: parseId(committerM)
    })
    if (commit.sha !== sha) throw new Error(`${sha} 远端生成的 commit ${commit.sha} 与本地不一致`)
    await api('PATCH', `/repos/${repo}/git/refs/heads/${branch}`, { sha: commit.sha, force: false })
    console.log(`✓ ${sha} 已推送（hash 与本地一致）`)
    parentSha = sha
  }
  console.log(`完成：远端 ${branch} = ${parentSha}`)
}

main().catch((err) => { console.error(err.message); process.exit(1) })
