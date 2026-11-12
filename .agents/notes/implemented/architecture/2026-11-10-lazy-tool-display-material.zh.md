# Agent Note: 按需加载工具展示数据

Status: implemented

[English](2026-11-10-lazy-tool-display-material.md) | 中文

## Problem

外部历史记录可能只提供有界的参数和结果预览。独立详情节点会在对话中重复工具调用；预先读取全部结果则破坏分页效果。

## Decision

可选的 Session 标准属性 `createToolMaterial` 为每个视图准备一个惰性的只读数据句柄。Chat 的展开状态绑定负责提交后的激活、快照订阅、展开观察和释放。工具视图只调用框架生成的钩子，并通过原有 keyed toolview 渲染发布的 block。提供方负责读取、校验、取消和缓存。

准备过程不获取资源，因为 React 可能丢弃一次渲染。句柄支持 Strict Mode 清理后的重新激活，在数据变化前保留快照引用，并在折叠或释放时取消未完成的读取。快照读者共享激活状态，直到最后一个读者离开。

## Alternatives considered

独立详情节点重复调用。提供方复制原生卡片会与已有 toolview 脱节。返回 React 节点的回调隐藏了组合路径；纯数据句柄保留已有 slot 的渲染权。业务自行订阅或制造展开钩子会重复框架的职责。

## Consequences

无关调用保留原有 disclosure Hook。在数据源渲染与普通渲染之间切换时，原子卡片会重新挂载以隔离 Hook 生命周期。加载和重试仍属于同一个调用条目。本契约不新增 Session 记录、模型输入、工具执行或后端 API。
