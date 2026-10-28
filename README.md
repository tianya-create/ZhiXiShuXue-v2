# 智慧教育平台 - 项目文档

## 项目概览

这是一个在线教育平台，包含教师端、学生端和后台管理端三个子系统，采用前后端分离架构。

### 技术栈

**前端**
- Vue 3.5 + Vite 5
- Element Plus 2.13 (UI组件库)
- ECharts 5.6 (图表库)
- Vue Router 4 (路由)
- Pinia 2 (状态管理)
- Axios (HTTP客户端)
- Day.js (日期处理)

**后端**
- Node.js + Express 4
- JWT (认证)
- Bcrypt (密码加密)
- Multer (文件上传)
- 内存数据库 (JavaScript对象模拟)

## 项目结构

```
/workspace/projects/
├── backend/                    # 后端服务
│   ├── server.js              # 服务入口
│   ├── database/
│   │   └── memory-db.js       # 内存数据库
│   └── routes/
│       ├── auth.js            # 认证路由
│       ├── teacher.js         # 教师端路由
│       ├── student.js         # 学生端路由
│       ├── admin.js           # 管理端路由
│       └── common.js          # 公共路由
│
├── frontend/                   # 前端应用
│   ├── src/
│   │   ├── main.js            # 入口文件
│   │   ├── App.vue            # 根组件
│   │   ├── router/            # 路由配置
│   │   ├── stores/            # Pinia状态管理
│   │   ├── utils/             # 工具函数
│   │   ├── styles/            # 全局样式
│   │   ├── layouts/           # 布局组件
│   │   │   ├── TeacherLayout.vue
│   │   │   ├── StudentLayout.vue
│   │   │   └── AdminLayout.vue
│   │   └── views/             # 页面组件
│   │       ├── teacher/       # 教师端页面
│   │       ├── student/       # 学生端页面
│   │       └── admin/         # 管理端页面
│   └── vite.config.js         # Vite配置
│
└── package.json               # 项目根配置
```

## 开发命令

```bash
# 安装所有依赖
pnpm install:all

# 启动开发环境 (后端 + 前端)
pnpm dev

# 仅启动后端
pnpm server

# 仅启动前端
pnpm client

# 构建生产版本
pnpm build
```

## 默认账号

系统初始化后提供以下演示账号：

| 角色 | 用户名 | 密码 |
|------|--------|------|
| 教师端 | teacher | teacher123 |
| 学生端 | student | student123 |
| 管理端 | admin | admin123 |

## 端口配置

- 前端开发服务器: 5000
- 后端API服务器: 5001

## 功能模块

### 教师端
- 班级/学生管理
- 试卷上传与管理
- 题目管理与添加
- 作业发布与批改
- 班级学情分析
- 学生个人学情查看

### 学生端
- 作业查看与答题
- 知识图谱查看
- 薄弱知识点清单
- 薄弱补练
- 错题本
- 学习轨迹

### 管理端
- 用户管理
- 知识点体系管理
- 题库管理
- 系统配置(OCR/大模型API)
- 操作日志
- 数据统计与导出

## API接口

### 认证接口
- POST /api/auth/login - 登录
- POST /api/auth/logout - 退出
- POST /api/auth/change-password - 修改密码
- GET /api/auth/verify - 验证token

### 教师端接口
- GET /api/teacher/classes - 班级列表
- POST /api/teacher/classes - 创建班级
- GET /api/teacher/papers - 试卷列表
- POST /api/teacher/papers/upload - 上传试卷
- GET /api/teacher/assignments - 作业列表
- GET /api/teacher/analytics/class/:id - 班级学情
- GET /api/teacher/analytics/student/:id - 学生学情

### 学生端接口
- GET /api/student/profile - 个人信息
- GET /api/student/assignments - 作业列表
- POST /api/student/assignments/:id/submit - 提交答案
- GET /api/student/knowledge-graph - 知识图谱
- GET /api/student/weak-points - 薄弱知识点

### 管理端接口
- GET /api/admin/users - 用户列表
- GET /api/admin/knowledge-points - 知识点树
- GET /api/admin/questions - 题库列表
- GET /api/admin/statistics/overview - 数据概览
- GET /api/admin/logs - 操作日志

## 样式规范

项目采用蓝白渐变主题：
- 主色调: #409EFF (Element Plus Primary Blue)
- 渐变起点: #E6F0FF
- 渐变终点: #FFFFFF
- 成功色: #67C23A
- 警告色: #E6A23C
- 危险色: #F56C6C

## 注意事项

1. 使用内存数据库，服务重启后数据会重置
2. 文件上传存储在 backend/uploads/ 目录
3. 前端通过 Vite proxy 代理访问后端 API
4. JWT token 有效期为7天
