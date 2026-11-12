---
kind: upgrade-guide
description: "自定义 Client Session 传输现在必须在打开历史前提供 sessionHistory 发现命名空间。"
---
# Client Session 历史发现

[English](guide.md) | 中文

## 变更

Client Session 会先通过 `sessionHistory.info` 发现历史数据源，再打开历史。仅提供原有 `session` 命名空间的自定义 Remote 载体、测试替身和非 owner 访问策略需要更新。API 仍处于稳定前阶段；Host 与 Client 产物必须来自同一次构建。普通原生 `session.events`、`follow`、投影和 SDK 消息保留原有格式。无需迁移 Session 数据。

## 迁移

1. 通过 `pnpm run build:artifacts` 一起重新构建并部署 Host 与 Client。该命令重新生成 Typert Host 定义和 Client Remote 类型，包括 `ClientRemote['sessionHistory']`；不要手工修改生成的声明。也要部署重新构建的 `@deepseek-ai/dsh-api-remotes` 包：它的 Client bundle 内嵌所选择的生成 Remote contribution。仅更新 Session Controller 会让旧的组合缺少 `remote.sessionHistory`，导致 Session Client 无法启动。
2. 自定义 Client 载体需要提供 `sessionHistory.info/page/observe`。原生数据源返回 `{ kind: 'native' }`。使用生成的类型，不再手写另一套线上接口。
3. 非 owner Client 需要发现能力时，在已经可读取的 Session 资源上明确授权 `sessionHistory/info`。外部分页和观察需要各自的策略决定；原生历史授权不包含这些能力。
4. 外部引擎插件通过 `sessionController.registerExternalHistoryProvider` 注册。呈现位置仅用于展示：不能传给原生 fork、精确重放或 `loadThrough`。确认原生聊天保留既有行为，外部聊天分页不把转录副本写入 SessionPersistence。

集成必需的包包括 `@deepseek-ai/dsh-api-session-controller`、`@deepseek-ai/dsh-api-remotes`、`@deepseek-ai/dsh-client-ui-chat`、`@deepseek-ai/dsh-client-ui-conversation` 和 `@deepseek-ai/dsh-client-ui-trajectory`。它们同时包含生成的 Remote 组合及其展示消费者；仅靠这五个包不能证明与其他修订构建的基础运行时兼容。

部署来自同一 checkout 和同一次构建的完整运行时依赖闭包及基础 Web 前端，包括 UI renderer 和静态打包的 `ui-slots` 代码。相同的稳定前版本号不保证不同修订之间的 ABI 兼容。覆盖不同基础版本的局部更新可能成功注册所有服务并传输历史，但 renderer 仍会丢弃对话主体。当基础修订不同或无法确认时，应更新完整运行时。
