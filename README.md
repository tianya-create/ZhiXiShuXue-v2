# 智慧教育平台

## 启动

```bash
npm install
cd backend && npm install
cd ../frontend && npm install
cd ../backend && npm run seed:demo
cd .. && npm run dev
```

## 演示账号
- 用户名：`student-demo`
- 密码：`student123`

## 默认端口
- 前端: `5000`
- 后端: `5001`
- WebSocket: `/ws`

## 新增知识图谱能力
- `GET /api/common/knowledge-graph`：分页 + 学科过滤
- `GET /api/common/wrong-q/:knowledgeId`：近 20 条错题
- `GET /api/common/recommend-q/:knowledgeId`：3-5 题推荐补练
- 力导向图、节点聚焦、状态过滤、IndexedDB 缓存、浏览器检测、错误边界

## 测试

```bash
cd backend
npm test
```
