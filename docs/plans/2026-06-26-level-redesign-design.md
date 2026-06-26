# 级别体系重设计（4 档 → 6 档）设计

> **For Claude:** 本文是设计文档；实施计划由 writing-plans 另出。

## 目标（动机）

现 4 档（新手/初级/中级/高级）太粗，尤其「中级」覆盖的球技范围过广，自评不准。参考日本站 6 级体系，改成 **6 档 + 每档一句说明**，让球友凭说明更准确地自评。

## 级别体系（前后端共识）

| 权重 | 名称 | 说明（前端 LEVEL_DESC，picker 选用时显示） |
|---|---|---|
| 1 | 新手 | 几乎没打过/很久没打 |
| 2 | 入门 | 能回轻球，短拉锯 |
| 3 | 初级 | 高远/吊球稳定，中长拉锯 |
| 4 | 中级 | 会杀球/假动作，攻守多变 |
| 5 | 中高级 | 有战术，能和高手抗衡 |
| 6 | 高级 | 接近专业 |

- 徽章 / 规则文案显示**中文名**。
- 旧 4 档里 `新手/初级/中级` 名字不变（仅权重随档位重排）；`高级` 含义变严（=接近专业，旧「高级」≈新「中高级」）。

## 两个已拍板的决策

1. **6 级体系**（上表，含中高级/高级改名），每档带说明。
2. **现有级别数据全重置**（不做映射）：`user.level` 全清空、活动级别规则（`minLevel`/`allowedLevels`）全删除。理由：旧粗档自评在新细档下本就不准，重置后凭新说明重选最准。

## 架构：方案 A（前端 util 统一 + 后端只留枚举/权重）

| | 做法 |
|---|---|
| **A（选定）** | 新增 `miniprogram/utils/levels.js` 导出 `LEVELS`(6 名)+`LEVEL_DESC`(名→说明)，profile/create/detail 全 import，干掉 5 处硬编码数组；后端 `logic.js` 只更新 `LEVELS`+`LEVEL_WEIGHT`（说明是纯 UI 文案，后端不要） |
| B（否决） | 后端 `GET /api/meta/levels` 下发，前端拉取缓存 —— 多端点+异步时序，过度工程 |
| C（否决） | 不抽 util，5 处原地改 —— 重复，将来改 5 次 |

选 A：DRY（前端 5 处合一、一处改全处生效）；前后端各留一份枚举无法避免（小程序无构建），但说明只在前端。

## 后端（`server/src/logic.js`，**无新端点**）

- `LEVELS = ['新手','入门','初级','中级','中高级','高级']`
- `LEVEL_WEIGHT = {新手:1, 入门:2, 初级:3, 中级:4, 中高级:5, 高级:6}`
- `levelWeight` 未知默认 = `入门(2)`（保守：未知玩家按偏入门算）。
- `validateRules` / `register` / `generateGroups` / `assignOneRound` / `generateRotation` **逻辑不动**——都基于 `LEVELS.includes` 与 `levelWeight`，自动支持 6 档。错误文案用级别名，自动正确。
- `enrichActivity` 名单 entry 的 `level` 字段不变（仍下发中文名）。

## 前端（新增 `miniprogram/utils/levels.js` + 改 3 页）

- `utils/levels.js`：导出 `LEVELS` + `LEVEL_DESC`。
- **profile**：`levels` 改用 util；picker 选完在下方显示该级说明（`levelDesc`），帮自评。
- **create**：`levelOptions` 改用 util；白名单 tag 显示名称；`minLevel` picker 选完显示说明。默认 `ruleMinLevel` 仍 `中级`。
- **detail**：代理报名那两处硬编码数组（detail.wxml:48 的 picker、detail.js:375 的 onProxyLevel）改用 util；名单徽章仍只显示名称（紧凑）。

## 数据迁移（一次性脚本 `server/scripts/migrate-levels.js`，**全重置**）

- 先备份 `data/db.json` → `data/db.json.bak-levels`。
- 所有 `user.level` → `''`；所有 `activity.rules.minLevel` / `activity.rules.allowedLevels` 删除（**保留** `noShowBanDays`/`cancelDeadlineHours`/`allowedGenders` 等其它规则）。
- 幂等：跑前检测有无旧级别值，没有就跳过、不动文件。
- 运行：`cd server && node scripts/migrate-levels.js`（跑一次）。

## 测试（`server/tests/logic.test.js`）

- 旧用例里 `新手/初级/中级/高级` 名字在新枚举里**都还在**，多数断言（顺序/归属）仍过；但权重变了（新手1/初级3/中级4/高级6），跑全量修任何挂掉的（主要是断言了具体权重或档位数）。
- 新增：6 档校验、`入门`/`中高级` 的 minLevel/allowedLevels、权重 1–6 顺序。

## 已知简化

- 前后端枚举各维护一份（小程序无构建，无法共享）——util 至少前端合一。
- 不做 `GET /api/meta/levels`（YAGNI，级别表基本不变）。
- 未知水平默认权重 `入门(2)`：影响分组公平，保守偏入门。

## 不做（YAGNI）

- 后端下发级别说明（meta 端点）。
- 旧→新级别映射（已决定全重置）。
- 服务器启动自动迁移（用一次性脚本，更显式可控）。
- 名单徽章显示说明（只显示名称，紧凑）。
