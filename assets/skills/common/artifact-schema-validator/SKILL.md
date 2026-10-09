---
name: artifact-schema-validator
description: 校验各环节产物是否符合预定义 Schema（source-item / briefing-item / topic / draft / visual-pack / style-profile）。检查必填字段、字段类型、枚举值是否合法。校验失败返回具体字段错误，不允许把不合规数据传给下一环节。
---
# 产物结构校验

## 何时使用

每个环节产出结构化数据后，交给下一环节之前调用。

## 可用 Schema

- `source-item` — 原始资讯单条
- `briefing-item` — 日报单条
- `topic` — 创作方向
- `draft` — 文章各阶段产物
- `visual-pack` — 视觉产物
- `style-profile` — 文风档案

## 检查项

1. 必填字段是否齐全
2. 字段类型是否正确
3. 枚举值是否在允许范围内
4. 引用的 ID 是否真实存在

## 输出

- `valid` / `invalid`
- 错误列表，逐项给字段名与原因

## 硬规则

- 校验不通过时阻断传递，不要带着错误继续
- 错误信息要指出是哪个字段、期望什么、实际是什么

## 禁止

- 不自动补默认值掩盖缺失字段
- 不跳过校验直接传下游
