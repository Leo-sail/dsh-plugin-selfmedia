---
name: image-negative-prompt
description: 生成负面提示词。通用基础每次都加：watermark, text overlay, logo, blurry, low quality, distorted faces, extra limbs, bad anatomy, chinese characters, deformed hands。按风格追加相应排除项。
---
# 负面提示词

## 通用基础（每次都加）

```
watermark, text overlay, logo, blurry, low quality,
distorted faces, extra limbs, bad anatomy,
chinese characters, deformed hands
```

## 按风格追加

- 写实风格：加 `cartoon, anime, illustration`
- 扁平风格：加 `photorealistic, 3D render, shadow`

## 硬规则

- 通用基础不可省略
- 风格追加项要与选定风格一致

## 禁止

- 不省略 chinese characters（防止模型乱画中文）
- 不加与风格冲突的排除项
