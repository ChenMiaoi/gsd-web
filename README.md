# gsd-web

`gsd-web` 是一个本地优先的 GSD 项目清单面板。它用 Fastify 提供 API 和静态资源服务，用 React 渲染浏览器面板，用 SQLite 持久化已登记项目、快照、监控状态、初始化任务和时间线。

## 功能

- 登记本机项目路径，并为每个项目保留稳定的 `projectId`
- 只读扫描项目目录和 `.gsd` bootstrap 状态
- 展示 `initialized`、`uninitialized`、`degraded` 等真实快照状态
- 监控项目路径丢失、恢复、重连和刷新事件
- 支持在面板中触发受支持的 `/gsd init` 流程
- 通过 Server-Sent Events 实时同步项目事件
- 内置 i18n，当前支持 English 和中文

## 环境要求

- Node.js `>=24.0.0`
- npm
- 如需使用面板里的初始化功能，需要本机可执行：
  - `gsd`
  - `python3`

## 快速开始

作为 npm 包安装后，用户只需要运行：

```bash
gsd-web
```

本地开发时：

```bash
npm install
npm run build
npm run start
```

默认服务地址：

```text
http://127.0.0.1:3000
```

开发时可以直接运行 TypeScript 后端：

```bash
npm run dev
```

注意：`npm run dev` 仍然服务 `dist/web` 下的前端产物。第一次运行或改动前端后，请先执行 `npm run build`。

## 使用面板

1. 打开 `http://127.0.0.1:3000`
2. 在 `Project path` 输入一个本机项目的绝对路径
3. 点击 `Register project`
4. 在左侧清单选择项目，右侧查看：
   - 快照状态
   - 监控健康度
   - 项目连续性
   - 初始化任务
   - 目录摘要
   - 快照来源状态
   - 仓库元数据
   - 最近时间线

如果项目路径被移动或删除，面板会保留最近一次良好快照，并在项目进入 `path_lost` 状态时提供重连入口。

## i18n

面板右上角提供语言切换，当前支持：

- `EN`
- `中文`

语言偏好会保存到浏览器 `localStorage`：

```text
gsd-web.locale
```

文案集中在：

```text
src/web/i18n.ts
```

新增语言时，扩展 `Locale` 类型和 `UI_COPY` 字典即可。

## 常用命令

```bash
npm run clean       # 删除 dist
npm run build       # 构建前端和后端
npm run build:web   # 只构建 React/Vite 前端
npm run build:server# 只编译 TypeScript 后端
npm run dev         # 运行源码后端
npm run cli         # 构建后用 gsd-web CLI 入口运行
npm run start       # 运行 dist 后端
npm test            # 运行 Vitest 集成测试
npm run test:e2e    # 运行 Playwright 端到端测试
```

## 配置

常用环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 服务监听地址 |
| `PORT` | `3000` | 服务监听端口 |
| `GSD_WEB_HOME` | `~/.gsd-web` | gsd-web 运行时目录 |
| `GSD_WEB_DATABASE_PATH` | `~/.gsd-web/data/gsd-web.sqlite` | 项目注册表 SQLite 路径 |
| `GSD_WEB_LOG_DIR` | `~/.gsd-web/logs` | 默认日志目录 |
| `GSD_WEB_LOG_FILE` | `~/.gsd-web/logs/gsd-web.log` | Fastify/Pino JSONL 日志文件 |
| `GSD_WEB_LOG_LEVEL` | `info` | 服务日志等级 |
| `GSD_WEB_CLIENT_DIST_DIR` | 包内 `dist/web` | 前端静态资源目录 |
| `GSD_BIN_PATH` | `gsd` | `/gsd init` 驱动使用的 GSD 可执行文件 |

示例：

```bash
PORT=3001 GSD_BIN_PATH=/path/to/gsd gsd-web
```

默认数据库路径：

```text
~/.gsd-web/data/gsd-web.sqlite
```

默认服务日志路径：

```text
~/.gsd-web/logs/gsd-web.log
```

默认前端静态资源目录：

```text
<npm package>/dist/web
```

## API 参考

健康检查：

```bash
curl http://127.0.0.1:3000/api/health
```

项目清单：

```bash
curl http://127.0.0.1:3000/api/projects
```

登记项目：

```bash
curl -X POST http://127.0.0.1:3000/api/projects/register \
  -H 'content-type: application/json' \
  -d '{"path":"/absolute/path/to/project"}'
```

项目详情：

```bash
curl http://127.0.0.1:3000/api/projects/<projectId>
```

刷新项目：

```bash
curl -X POST http://127.0.0.1:3000/api/projects/<projectId>/refresh
```

初始化项目：

```bash
curl -X POST http://127.0.0.1:3000/api/projects/<projectId>/init
```

重连项目路径：

```bash
curl -X POST http://127.0.0.1:3000/api/projects/<projectId>/relink \
  -H 'content-type: application/json' \
  -d '{"path":"/absolute/path/to/moved/project"}'
```

事件流：

```bash
curl -N http://127.0.0.1:3000/api/events
```

## 快照判定

项目没有 `.gsd` 目录时，快照状态为 `uninitialized`。

项目存在 `.gsd` 目录时，服务会检查以下来源：

- `.gsd-id`
- `.gsd/PROJECT.md`
- `.gsd/repo-meta.json`
- `.gsd/auto.lock`
- `.gsd/STATE.md`
- `.gsd/gsd.db`

所有来源可读且格式符合预期时，状态为 `initialized`。如果存在缺失、不可读或格式错误的来源，状态为 `degraded`，对应警告会显示在面板中。

## 开发提示

- 后端入口：`src/server/index.ts`
- Fastify app：`src/server/app.ts`
- 项目 API：`src/server/routes/projects.ts`
- SSE API：`src/server/routes/events.ts`
- 前端入口：`src/web/App.tsx`
- 前端样式：`src/web/styles.css`
- 共享契约：`src/shared/contracts.ts`
- i18n 文案：`src/web/i18n.ts`

构建产物会写入：

```text
dist/web
dist/server
```
