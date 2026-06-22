# 轮转表号码前缀 + PNG 导出 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 轮转表每个球友名字前加报名序号（1-小张），并支持把整张轮转表导出成 PNG 图片（预览/存相册/转发）。

**Architecture:** 纯前端改动。`detail.js` 给轮转 schedule 注入 `no`（报名序号）；wxml 展示「N-名字」；新增 `exportRotation()` 用离屏 `#poster` canvas（动态高度）画整张表 → `canvasToTempFilePath` → `previewImage`。无后端改动、无单测。

**Tech Stack:** 微信小程序原生 JS / WXML / canvas 2d。

**Branch:** 在当前 `feat/phase1-organizer-features` 上继续。

**参考：** 设计 `docs/plans/2026-06-21-rotation-export-design.md`。

---

## Task 1: 名字加报名序号（注入 + 展示）

**Files:** `miniprogram/pages/detail/detail.js`、`detail.wxml`。（`node --check`。）

### Step 1: detail.js — 加注入辅助 + 在 genRotation/load 调用

加方法（放 `genRotation` 附近）：
```js
  // 给轮转 schedule 的每个 player 注入报名序号 no（confirmed 里第几个=几号）。
  _injectRotationNo(rotation, confirmed) {
    if (!rotation || !rotation.schedule) return rotation;
    const noMap = {};
    (confirmed || []).forEach((x, i) => { noMap[x.openid] = i + 1; });
    rotation.schedule = rotation.schedule.map((rd) =>
      rd.map((c) => c.map((p) => ({ ...p, no: noMap[p.openid] || '?' })))
    );
    return rotation;
  },
```

`genRotation` 里，setData 前注入（用当前 detail.confirmed）：
```js
      this.setData({ detail: { ...d.detail, rotation: this._injectRotationNo(r.rotation, d.detail.confirmed) } });
```

`load()` 里，在 `this.setData({...})` 之前（`d` 已拿到、含 confirmed 与 rotation），注入（用 `d.confirmed`）：
```js
      if (d.rotation) d.rotation = this._injectRotationNo(d.rotation, d.confirmed);
```
（加在 `this.setData({ feeEdit, ... })` 之前即可，例如紧跟 `feeEdit` 计算之后。）

### Step 2: detail.wxml — 轮转展示改「N-名字」

把轮转结果区里每个 court 的展示，从纯 nickname 改成「`no-nickname`」。当前（在 `<block wx:if="{{detail.rotation}}">` 内）：
```xml
          <view wx:for="{{round}}" wx:for-item="court" wx:for-index="ci" wx:key="*this" style="padding:4rpx 0;">
            <text class="muted">场{{ci+1}}：</text>{{court[0].nickname}}{{court[1] ? '/' + court[1].nickname : ''}}{{court[2] ? '/' + court[2].nickname : ''}}{{court[3] ? '/' + court[3].nickname : ''}}
          </view>
```
改为：
```xml
          <view wx:for="{{round}}" wx:for-item="court" wx:for-index="ci" wx:key="*this" style="padding:4rpx 0;">
            <text class="muted">场{{ci+1}}：</text>{{court[0].no}}-{{court[0].nickname}}{{court[1] ? ' / ' + court[1].no + '-' + court[1].nickname : ''}}{{court[2] ? ' / ' + court[2].no + '-' + court[2].nickname : ''}}{{court[3] ? ' / ' + court[3].no + '-' + court[3].nickname : ''}}
          </view>
```

### Step 3: 语法自检 + 提交
```bash
cd /home/li-du/badminton
node --check miniprogram/pages/detail/detail.js
git add miniprogram/pages/detail/detail.js miniprogram/pages/detail/detail.wxml
git commit -m "feat(ui): prefix rotation names with roster number (N-名字)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: 导出 PNG（canvas 画整张轮转表）

**Files:** `miniprogram/pages/detail/detail.js`、`detail.wxml`。（`node --check` + 真机手测。）

### Step 1: detail.js — 加 exportRotation

加方法（放 `clearRotation` 附近）：
```js
  async exportRotation() {
    const detail = this.data.detail;
    const rot = detail && detail.rotation;
    if (!rot || !rot.schedule) return wx.showToast({ title: '请先生成轮转', icon: 'none' });
    wx.showLoading({ title: '生成图片' });
    try {
      // 名字/号码映射（schedule 已注入 no；resting 只有 openid，需查名单）
      const rosterMap = {};
      (detail.confirmed || []).forEach((x, i) => { rosterMap[x.openid] = { no: i + 1, nickname: x.nickname || '' }; });
      const label = (p) => (p.no || (rosterMap[p.openid] && rosterMap[p.openid].no) || '?') + '-' + (p.nickname != null ? p.nickname : (rosterMap[p.openid] && rosterMap[p.openid].nickname) || '');

      const W = 375;
      const lineH = 36;
      const pad = 24;
      const courts = rot.schedule[0] ? rot.schedule[0].length : 1;
      const lines = 2 + rot.schedule.length * (1 + courts + 1); // 标题2 + 每轮(轮头+courts+休息)
      const H = lines * lineH + pad * 2;

      const { canvas, ctx } = await new Promise((res, rej) => {
        wx.createSelectorQuery()
          .select('#poster')
          .fields({ node: true })
          .exec((r) => (r && r[0] && r[0].node ? res({ canvas: r[0].node, ctx: r[0].node.getContext('2d') }) : rej(new Error('canvas 不存在'))));
      });
      const dpr = wx.getSystemInfoSync().pixelRatio;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      ctx.scale(dpr, dpr);

      // 背景
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, H);

      // 标题
      ctx.fillStyle = '#111827';
      ctx.font = 'bold 28px sans-serif';
      ctx.fillText((detail.title || '活动') + ' · 轮转表', pad, pad + 24);
      let y = pad + 24 + lineH;

      // 逐轮
      rot.schedule.forEach((rd, ri) => {
        ctx.fillStyle = '#16a34a';
        ctx.font = 'bold 24px sans-serif';
        ctx.fillText('第 ' + (ri + 1) + ' 轮', pad, y);
        y += lineH;
        ctx.fillStyle = '#374151';
        ctx.font = '22px sans-serif';
        rd.forEach((c, ci) => {
          ctx.fillText('  场' + (ci + 1) + ': ' + c.map(label).join(' / '), pad, y);
          y += lineH;
        });
        const rest = (rot.resting[ri] || []).map(label).join('、');
        ctx.fillStyle = '#9ca3af';
        ctx.fillText('  休息: ' + (rest || '无'), pad, y);
        y += lineH;
      });

      wx.canvasToTempFilePath({
        canvas,
        success: (out) => {
          wx.hideLoading();
          wx.previewImage({ urls: [out.tempFilePath] }); // 长按可存相册/转发
        },
        fail: () => {
          wx.hideLoading();
          wx.showToast({ title: '生成失败', icon: 'none' });
        },
      });
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: e.message || '生成失败', icon: 'none' });
    }
  },
```

> 复用现有离屏 `<canvas id="poster">`（Phase 1 海报用的，CSS 屏外隐藏）。导出时动态设 buffer 高度（按轮数/court 数）。`label()` 同时处理 schedule entry（已有 no/nickname）和 resting openid（查 rosterMap）。

### Step 2: detail.wxml — 轮转结果区加「导出图片」按钮

在「清除轮转」按钮后面加：
```xml
      <button wx:if="{{detail.rotation}}" class="btn btn-ghost" style="margin-top:12rpx;" bindtap="exportRotation">导出轮转表(图片)</button>
```

### Step 3: 语法自检 + 提交
```bash
cd /home/li-du/badminton
node --check miniprogram/pages/detail/detail.js
git add miniprogram/pages/detail/detail.js miniprogram/pages/detail/detail.wxml
git commit -m "feat(ui): export rotation table as PNG (canvas → preview/share)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: 收尾 — 验证 + 文档

### Step 1: 前端语法扫描
```bash
for f in miniprogram/pages/*/*.js miniprogram/utils/*.js; do node --check "$f" || echo "FAIL $f"; done
```
### Step 2: 后端全测不受影响（纯前端改动）— `cd server && npm test` 应仍 50/50。
### Step 3: 更新 README/CLAUDE.md
- README 轮转一行补：名单带报名序号、可导出 PNG 图片分享。
- CLAUDE.md Phase 5 要点补：轮转展示「N-名字」、`exportRotation` canvas→PNG。
### Step 4: 提交
```bash
git add CLAUDE.md README.md
git commit -m "docs: rotation number-prefix + PNG export in README/CLAUDE.md

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## 风险与备注

- canvas 渲染**真机为准**（模拟器 canvas 2d 偶有差异，CLAUDE.md 已记）。
- 长名字（court 行 4 人「N-名/…」）可能超画布宽被裁——MVP 不做自动换行（中文名短，一般够；要更稳可缩字号或加宽 canvas）。
- 号码是**报名序号**，load 时按当前 confirmed 重新注入（永远跟当前名单一致）。
- 复用 `#poster` canvas（与活动海报互斥；不同时使用）。
- 小程序无法自动发群：导出图片后由用户长按转发/存相册。
