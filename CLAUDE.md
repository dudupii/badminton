# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 这是什么

羽毛球活动报名**微信小程序 + Node/Express 后端**。功能：发起活动（名额/时间）、用微信身份报名、名额满转候补、有人取消按 FIFO 自动上位、每个活动生成二维码供他人扫码报名。Phase 1 加了组织者向四件套：**复制上一场**（`GET /api/activities/created-by/me`，+7 天顺延）、**候补上位订阅通知**（一次性订阅消息，事件驱动）、**水平/性别标签**（用户资料 + 名单徽章 + 男/女汇总）、**可分享运动主题海报**（canvas 2d）。Phase 2 又加了：**活动编辑**（`PUT /api/activities/:id`，仅发起人，名额不可低于已正式人数）、**周期活动**（`POST /api/activities` 带 `repeat`，一次生成≤12 场）、**报名成功 + 活动前提醒订阅**（提醒靠唯一的 `setInterval` 调度器）、**头像持久化**（`POST /api/user/me/avatar` base64 上传，本地文件 + `express.static('/avatars')`）。

仓库两部分：
- `server/` — Express 后端（唯一运行时依赖 `express` + `qrcode`）。
- `miniprogram/` — 微信小程序前端（原生 JS，无构建步骤）。仓库根的 `project.config.json` 用 `miniprogramRoot: "miniprogram/"` 指向前端代码。

## 常用命令

后端（在 `server/` 下）：
```bash
npm install
npm start              # 启动 http://0.0.0.0:3000
npm run dev            # node --watch，改动自动重启
npm test               # node --test tests/*.test.js（全部）
node --test --test-name-pattern="候补" tests/logic.test.js   # 跑单个用例（按名称子串过滤）
```
- 小程序需要后端在跑才能联调。
- 配置走 `.env`（从 `.env.example` 拷贝）：`PORT`/`HOST`/`DATA_FILE`/`TOKEN_SECRET`/`WX_APPID`/`WX_SECRET`/`WX_ENV_VERSION`；订阅模板 `WX_PROMOTE_TPL`/`WX_REGISTERED_TPL`/`WX_REMIND_TPL`；提醒调度 `REMIND_LEAD_HOURS`/`REMIND_INTERVAL_SECONDS`（皆可选）。
- 没有 `WX_APPID`+`WX_SECRET` 时自动进 **devMode**（见下），无需任何微信凭证即可联调。

小程序：用微信开发者工具导入**仓库根目录**（不是 `miniprogram/` 子目录）；`urlCheck:false` 已允许 HTTP 联调。本机装的是社区 Linux 移植版（msojocs），启动器 `~/bin/wechat-devtools`。

## 架构要点（跨多文件理解）

**原子性是核心设计。** 后端单进程、用 JSON 文件当数据库（`server/data/db.json`），但所有写操作必须走 `store.txn(fn)`（`src/store.js`）——它用一个 promise 链当互斥锁串行执行，并在结束后落盘。因此名额计数 / 候补 / 上位不会竞态。**新增任何状态变更都要写成一个 `txn`，读用 `store.snapshot()`（无需锁）。**

**领域逻辑全在 `src/logic.js`，`src/index.js` 是薄路由层。** 每个路由用 `wrap()` 包装：`wrap` 把 `logic` 抛出的 `{statusCode, message}` 错误映射成 HTTP 响应，成功则返回 `{ok,data}`。要改业务行为，改 `logic.js`；加端点，在 `index.js` 加路由调 `logic`。规则：
- 报名：`confirmed` 未满→正式；满→`waitlist`（按 `createdAt` 排序）。
- 取消正式名额→候补中**最早**者自动升 `confirmed`（FIFO）；取消候补不触发上位。
- 守卫：同一活动不可重复报名（取消后可再报）；活动已开始（`startTime < now`）或被发起人关闭后拒绝报名。
- 鉴权中间件：`requireAuth`（报名/取消/创建/删除/改资料，必须登录）；`optionalAuth`（活动列表/详情——公开可看，登录则附带 `myStatus`）。二维码图片端点 `GET /api/activities/:id/qrcode` 必须公开（`<image>` 不带 Authorization 头）。

**身份与登录（`src/auth.js` + `miniprogram/utils/{request,auth}.js`）。** 小程序 `wx.login` 拿 code → `POST /api/auth/login` → 后端用 code 换 openid：
- 生产：调微信 `code2session`（需 `WX_APPID`/`WX_SECRET`）。
- devMode：用客户端生成的 `devUserId` 派生稳定 openid（`dev_<devUserId>`），**所以单台模拟器/手机=一个稳定用户**。
openid → HMAC-SHA256 自签 token（无 JWT 依赖）。前端 `utils/request.js` 自动带 token，**收到 401 会自动重新登录并重试一次**。

**邀请码与二维码（`src/wxapi.js` + `src/logic.js` 的 `code`/`getActivityByCode`）。** 每个活动有 6 位邀请码（作为小程序码的 `scene`）。二维码端点：生产调 `wxacode.getUnlimited` 生成可扫码进小程序的「小程序码」；devMode 用 `qrcode` 库生成占位码。扫码进入时详情页 `onLoad` 读 `options.scene` → 按 code 加载活动；普通跳转用 `options.id`。

**前后端环境自动切换（`miniprogram/utils/config.js`）。** 用 `wx.getAccountInfoSync().miniProgram.envVersion`（develop/trial/release）自动选后端地址：`develop`→`DEV_URL`（开发机局域网 HTTP），`trial`/`release`→`PROD_URL`（公网 HTTPS）。发布前只需把 `PROD_URL` 改成正式域名。

**Phase 1 四件套的实现要点：**
- **水平/性别标签**：`user` schema 加 `level`/`gender`（枚举见 `logic.js` 顶部 `LEVELS`/`GENDERS`），`updateProfile` 校验枚举、`ensureUser` 给空默认值。`enrichActivity` 的每个名单 entry 带 `level`/`gender`，`GET /api/user/me` 也下发。前端 profile 用 `<picker>` 选择。
- **复制上一场**：`myCreatedActivities(store, openid)` 按活动 `createdAt` 倒序返回发起人的活动（**注意：`createActivity` 接受可选 `now` 参数注入 `createdAt`，与 `register`/`cancel` 一致，专测用，避免同毫秒排序歧义**）。前端 `create.js` 取 `list[0]`，时间 +7 天（同星期同时段）回填表单。
- **候补上位订阅**：订阅授权是一次性的——报名时前端 `wx.requestSubscribeMessage` 同意则 `POST /api/subscriptions` 给 `user.subs[templateId]` +1（`addSubscription`/`consumeSubscription`）。取消触发上位时，`POST /api/activities/:id/cancel` 路由层消费一次配额并调 `wxapi.sendSubscribeMessage`（**事件驱动、无定时器**；devMode 或模板未配不发送；发送失败非致命）。模板 id 双端配置：后端 `WX_PROMOTE_TPL`（`.env`）、前端 `SUBSCRIBE_TEMPLATES.promote`（`utils/config.js`，占位 `PROMOTE_TPL_ID` 未替换则跳过）。
- **活动海报**：`detail.js` 的 `generatePoster` 用 canvas 2d 画绿渐变 + 🏸 + 文案 + 二维码，`wx.canvasToTempFilePath` 导出后 `wx.previewImage` 预览。`<canvas>` **必须放在最外层、不在 `wx:if` 内**（否则 `createSelectorQuery` 取不到 node），靠 CSS 推到屏外隐藏。真机测（模拟器 canvas 2d 偶有渲染差异）。

**Phase 2 四件套的实现要点：**
- **活动编辑**：`updateActivity(store, id, actorOpenid, input)` 只允许发起人改、按字段增量更新；**capacity 不可低于当前 confirmed 人数**（会踢人）。路由 `PUT /api/activities/:id`（`PATCH` 仍只改 status）。前端 `create` 页带 `?id=` 进编辑模式，`loadForEdit` 预填、`submit` 走 PUT 后 `navigateBack`。
- **周期活动**：`createRecurring(store, input, creator, {count, stepDays})` 循环调 `createActivity`，每次 `startTime += stepDays`（最多 12 场，各自独立邀请码）。`POST /api/activities` 检测 `body.repeat`：`count>1` 走批量返回 `{activities:[...]]}`，否则单建返回单个。前端 `create` 页有重复 picker（不重复/每天/每周/自定义）+ 场数 + 间隔，编辑模式下隐藏。
- **报名成功 + 活动前提醒订阅**：报名成功是事件驱动（register 路由消费一次 `registered` 配额并发送，与 cancel→promote 同模式）。**活动前提醒是本应用唯一的定时器**——`index.js` 里 `reminderSweep()` 用 `setInterval`（默认 300s，`REMIND_INTERVAL_SECONDS`）扫描 `findActivitiesNeedingReminder`（`now<startTime≤now+REMIND_LEAD_HOURS` 且未 `remindedAt`），对每个命中活动调 `sendReminders`（原子消费每个报名者的 remind 配额并标记 `activity.remindedAt`，只发一次）后由路由层发消息。devMode/无模板时调度器整体跳过。三模板双端配置：后端 `WX_*_TPL`、前端 `SUBSCRIBE_TEMPLATES.*`；`doRegister` 一次性 `requestSubscribeMessage` 三个 tmplId，`registered` 配额在报名前授予（路由消费），`promote`/`remind` 报名后授予。
- **头像持久化**：`POST /api/user/me/avatar` 收 base64（≤2MB，`express.json` limit 已提到 2mb），写 `data/avatars/<openid>.<ext>`，`express.static('/avatars')` 公开服务。`logic.setAvatar` 存**服务器相对路径** `/avatars/...`，前端 `loadMe`/detail 名单渲染时用 `BASE_URL` 前缀解析。本地文件是存储后端，生产换 COS/S3。`saveProfile` 不再带 `avatarUrl`（归上传端点管）。

## 陷阱与非显而易见的事

- **测试是针对 `logic.js` 的单元级**（用内存 `Store`），不经过 HTTP。要验证 HTTP 层/路由，`curl` 正在跑的服务器；后端有请求日志中间件（跳过 health 与 OPTIONS），每个请求一行 `方法 路径 -> 状态 (耗时)`。
- **Linux 开发者工具的 `<picker>` 滚轮在 Wayland 下不滚动**（运行时缺陷，非代码 bug）。日历/时间选择器要在**真机**测；日志干净无错即属此情况。
- **别用 `pkill -f 'node src/index.js'`**——会匹配到命令自身、连带杀掉 shell（退出码 144）。停后台服务用它的任务句柄 / `kill <pid>`。
- **devMode 身份**：一台设备 = 一个 openid。测「多人报名/候补」要么换设备/清 storage 换身份，要么用 `curl` 以不同 `devUserId` 模拟他人。
- **生产部署**见 `DEPLOY.md`：必须 HTTPS + 备案域名，后端 `HOST=127.0.0.1` 走 Nginx 反代，`DATA_FILE` 用代码目录外的绝对路径（重新部署不丢数据）。
