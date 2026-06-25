# 公开小程序（B 路径：个人主体·正式发布·邀请制）设计

> **For Claude:** 本文是设计文档；实施计划由 writing-plans 另出。
> 关键事实（类目 / 人数 / 主体限制）已于 2026-06-25 核实微信官方文档，附来源。

## 目标

把羽毛球报名小程序从「devMode 自用」推进到「个人主体正式发布 · 邀请制自助 · 人数无上限」。
不是做可搜索发现的产品（C），不换企业主体，不接微信支付。

## 关键决策（已核实）

1. **"15 人太少"是误解。** 个人主体**体验成员上限 = 15**（[小程序产品定位](https://developers.weixin.qq.com/miniprogram/introduction/)），但这只是**体验版**（发布前测试者）名额，**不是用户上限**。**正式版全量发布后没有任何用户数量限制**（[协同工作和发布](https://developers.weixin.qq.com/miniprogram/dev/framework/quickstart/release.html)）。所以"球友多于 15 人"的解法是**发布正式版**，不是加体验者。

2. **个人主体可以发布正式版**，且本 app 用到的接口（`code2session` 登录、订阅消息、`getUnlimited` 小程序码）个人主体全部开放；**不接支付**正好绕开个人主体"无微信支付"的最大短板。无 API 拦路。

3. **类目首选「生活服务 → 预约/报名」**（[个人类目开放范围](https://developers.weixin.qq.com/minigame/product/mini-store/leimuzizhi/geren.html)）——个人主体在生活服务下**仅支持**此细分类目，本 app 就是活动报名工具，完美贴合、无需任何资质。备选「工具」。**避开「体育」**（场馆/赛事报名多需企业资质 + 体育经营许可证，个人过不了）。命名/简介统一写成「羽毛球活动报名/预约工具」，勿写「体育赛事平台」。

4. **发布节奏：快路径**（与"后端一上就提审"一致）——提审前只做**不可省**项，备份与防滥用放到"审核通过 → 正式发布"之间补。

## 三阶段计划

### 阶段 0 — 立刻并行启动（最长 lead time）
- **ICP 域名备案**（约 1–2 周，**最早动手**）：正式版 `request`/`downloadFile` 合法域名必须已备案。个人即可备案，无需企业主体。
- 租云主机 + 域名 A 记录指向服务器。

### 阶段 1 — 后端上线 + 提审前加固（提审硬前提，不可省）
- 后端按 `DEPLOY.md` 上线：Nginx 反代 + Let's Encrypt 证书 + systemd 服务 + `HOST=127.0.0.1`。
- `miniprogram/utils/config.js` 的 `PROD_URL` 改正式域名。
- `.env` 配真实 `WX_APPID`/`WX_SECRET`，**关 devMode**（`WX_ENV_VERSION=release`）——审核员真机体验需要真实登录。
- **用户隐私保护指引**：收集了 openid / 昵称 / 水平 / 性别 / 出勤 / 头像，正式版审核必查，需在后台填写。
- 真机走通完整流程一遍（建活动 → 报名 → 候补 → 取消上位 → 扫码），参照 `DEPLOY.md` 第五节清单。

### 阶段 2 — 提审 + 体验版并行跡坑
- 选「生活服务-预约/报名」类目，提交审核。
- 审核期间用体验版（15 人）给几个球友真用，膀平真实登录 / 数据问题。
- 审核通过 → 全量发布 → 人数无上限。

### 阶段 2.5 — 审核通过后、正式发布前补齐（发布前必做）
- **db.json 定时备份**：单文件 JSON DB + 零备份 = 最大隐患（`store.txn` 是全局串行的 promise 链，一次写坏即全量丢失）。定时备份 `db.json` + 启动时 snapshot 完整性校验。**个人规模不必换真 DB，备份兜底即可。**
- **轻量防滥用**：每用户建活动 / 建群限频、单群人数上限、活动文案长度限制 + 敏感词过滤（陌生人能自助建群后必须有）。

## 风险与回退
- **审核被拒** → 按拒因改类目 / 描述 / 功能后重提（[常见拒绝情形](https://developers.weixin.qq.com/miniprogram/product/reject.html)）；个人主体拒了可换「工具」类目再提。
- **数据丢失** → 阶段 2.5 的备份兜底（发布前到位）。
- **真实登录异常** → 阶段 2 体验版先验，发布前排除。

## 明确不做（YAGNI）
- C 路径：可搜索发现（额外扛合规 / 防滥用 / 内容审核，产品化才需要）。
- 企业主体迁移 / 微信认证。
- 微信支付。
- 换真实数据库（个人规模 JSON + 备份够；并发上来再说）。
- 复杂监控 / 告警体系。

## 来源
- [小程序产品定位及功能介绍](https://developers.weixin.qq.com/miniprogram/introduction/) — 体验成员 15 人、个人主体限制
- [协同工作和发布](https://developers.weixin.qq.com/miniprogram/dev/framework/quickstart/release.html) — 正式版无人数上限、全量/分阶段发布
- [个人类目开放范围](https://developers.weixin.qq.com/minigame/product/mini-store/leimuzizhi/geren.html) — 个人主体开放类目
- [小程序开放的服务类目](https://developers.weixin.qq.com/minigame/product/material/)
- [常见拒绝情形](https://developers.weixin.qq.com/miniprogram/product/reject.html)
