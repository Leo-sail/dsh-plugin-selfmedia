---
name: content-status-validator
description: 为采集结果统一标注内容状态与评论状态。内容状态码 complete/partial/not_available/permission_denied/not_found，评论状态码 available/partial/not_available/permission_denied/not_collected。任何状态都必须有对应说明，不允许留空。
---
# 内容状态校验

## 何时使用

每次采集完成后，在把数据交给下游之前调用。状态是下游一切判断的前提。

## 内容状态码

| 状态码 | 含义 |
|---|---|
| `complete` | 正文完整获取 |
| `partial` | 只拿到部分，例如仅有摘要 |
| `not_available` | 内容不存在或已删除 |
| `permission_denied` | 无访问权限 |
| `not_found` | 返回 404 |
| `unverified` | 拿到了但未能核实其准确性 |

## 评论状态码

| 状态码 | 含义 |
|---|---|
| `available` | 评论完整获取 |
| `partial` | 部分获取，分页未完成 |
| `not_available` | 评论区关闭 |
| `permission_denied` | 无权限访问评论区 |
| `not_collected` | 配置为不采集 |

## 硬规则

- 内容状态与评论状态必须同时标注
- 任何状态都必须附 status_reason，说明为什么是这个状态
- AIHOT 这类索引来源，正文状态只能是 `partial` 或 `not_available`
- 评论状态不是 `available` 或 `partial` 时，下游禁止提取评论观点

## 禁止

- 不因为"应该有正文"就把状态标成 `complete`
- 不把评论状态留空或写成 `unknown`
