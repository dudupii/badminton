# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 这是什么

羽毛球活动报名**微信小程序 + Node/Express 后端**。功能：发起活动（名额/时间）、用微信身份报名、名额满转候补、有人取消按 FIFO 自动上位、每个活动生成二维码供他人扫码报名。Phase 1 加了组织者向四件套：**复制上一场**（`GET /api/activities/created-by/me`，+7 天顺延）、**候补上位订阅通知**（一次性订阅消息，事件驱动）、**水平/性别标签**（用户资料 + 名单徽章 + 男/女汇总）、**可分享运动主题海报**（canvas 2d）。Phase 2 又加了：**活动编辑**（`PUT /api/activities/:id`，仅发起人，名额不可低于已正式人数）、**周期活动**（`POST /api/activities` 带 `repeat`，一次生成≤12 场）、**报名成功 + 活动前提醒订阅**（提醒靠唯一的 `setInterval` 调度器）、**头像持久化**（`POST /api/user/me/avatar` base64 上传，本地文件 + `express.static('/avatars')`）。Phase 3（自用打深）加了：**球费 AA**（`fee` 字段存「分」，总额均摊/固定人均两种、按正式/按实到，记账+签到+导出，不接支付）、**水平分组**（`generateGroups` 蛇形/首尾配对，按需算不入库）、**出勤统计**（`attendanceStats` 跨活动聚合实到/放鸽子）。Phase 4（报名规则）加了：**缺席惩罚 + 级别限制**两条可选规则（`activity.rules`，缺省都不启用），`register()` 报名时即时校验——缺席惩罚按"同组织者 + 窗口内 + `attended===false`"判，级别限制拦空水平。Phase 4.5（规则增强）扩成：级别限制**双模式**（`allowedLevels` 白名单 或 `minLevel` 某级以上，互斥）、新增性别限制 `allowedGenders`（⊆{男,女}，"不公开"拦）、缺席惩罚加**取消截止** `cancelDeadlineHours`（`cancel()` 过截止取消会标 `attended=false` 算缺席）+ 详情页警告横幅。Phase 5（轮转调度）加了：**多轮场地轮转**（`activity.rotation`，`generateRotation` 贪心逐轮：双打、不连休2轮硬约束（人数>8×场数时放宽）、公平/水平同质/固定搭档软；`POST/GET/DELETE /api/activities/:id/rotation`，池=签到到场者，入库可查）。

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

**Phase 3（自用打深）的实现要点：**
- **球费 AA**：`activity.fee = {totalCents, perPersonCents, splitBy}`（金额一律存**「分」整数**；`totalCents`/`perPersonCents` 二选一非空，`splitBy` ∈ `confirmed`/`attended`）。`setFee` 用 `wantsSet` 标志区分"设置"（任一字段在即视为设置意图，缺金额则 400）与"清空"（空 `{}`）。`enrichActivity` 按 splitBy 取池子（正式名单 / `attended===true` 者），`perPersonOwedCents` 算人均，给每个 confirmed entry 带 `owedCents`/`paid`/`attended`，并返回 `feeSummary{totalOwedCents,totalPaidCents,settled}`。**不接微信支付**——组织者记账（`markPaid`）+ 签到（`markAttend`，`attended` 三态 true/false/null）+ 导出。CSV 导出（`GET .../fee/export`）是独立 handler 不走 `wrap`（直接 `res.send` 文本+UTF-8 BOM）；前端 `exportFee` 因小程序无法带 token 下载，改为**用本地数据拼 CSV 复制到剪贴板**。
- **水平分组**：`generateGroups(confirmed,{mode,count})` 是**纯函数**（无 store），权重 新手1/初级2/中级3/高级4（空值按**初级2**）。`groups` 模式蛇形分发、`pairs` 模式首尾配对，每个返回项带 `weight`。**不入库**，`GET .../grouping` 实时算；前端把 `groups`（数组套数组）映射成 `{id,members}` 以满足 `wx:key`。
- **出勤统计**：`attendanceStats(store,organizerOpenid)` 跨"我创建的"活动聚合 registrations（只算 `status==='confirmed'`）：`attended`(attended===true) / `noShow`(attended===false) / `rate`，按 attended 降序。**共用 Phase 3 的 `attended` 字段**（签到既驱动按实到均摊，也驱动放鸽子统计）。
- **跨 Phase 一致**：三样都只读/扩展现有 `activity`/`registration`，无新核心实体；数据仍以"活动"为中心，将来加"群"套 `clubId` 过滤即可（留口子）。

**Phase 4（报名规则）的实现要点：**
- **数据模型**：`activity.rules = { noShowBanDays?, allowedLevels? }`（可选；缺省/空 → null）。`validateRules(input)` 纯函数校验：`noShowBanDays` 正整数、`allowedLevels` 是 `LEVELS` 非空子集（空数组算关闭）。`createActivity`/`updateActivity` 接受 `rules`（`updateActivity` 里 `if (input.rules !== undefined)` 才动；传 `null` 清空），`publicActivity` 透出。**无新端点**——随 create/edit 走。
- **报名时即时校验**（`register()` txn 内，重复报名守卫之后、算 `confirmedCount` 之前）：① 级别限制——`allowedLevels` 非空时，用户 `level` 为空 → 400「请先填水平」；不在集合 → 400「本活动限 X/Y 水平」。② 缺席惩罚——`noShowBanDays=N` 时，扫该用户在同一 `createdBy` 名下、`attended===false`、且活动 `startTime ∈ (now-N天, now]` 的报名，命中 → 400「你于 X月X日 缺席…N 天内无法报名」。
- **关键依赖/边界**：缺席判定**依赖 Phase 3 签到**（组织者须把人标 `attended=false`；`attended===null` 未签不算缺席）。范围 = **同一组织者**（`createdBy` 相同），跨组织者不互扰。规则只在"开启了该规则的活动"报名时检查；**不持久化惩罚态**，每次报名现场扫 registrations（自用规模可接受）。规则向前生效（据过往缺席历史拦）。
- **前端**：create 页（+编辑模式）「报名规则」可选区，两个 `<switch>` + 天数输入（自由输入/失焦规范化，复用 repeat 那套）+ 水平多选 tag；`loadForEdit` 回填；`submit` 把 `buildRules()` 结果挂到 `payload.rules`（create/edit 都带）。

**Phase 4.5（规则增强）的实现要点：**
- `rules` 新增三个可选字段：`minLevel`（某级及以上，权重比较）、`allowedGenders`（⊆{男,女}，**与 `allowedLevels` 互斥**的是 `minLevel`）、`cancelDeadlineHours`（开赛前 N 小时）。`validateRules` 增量校验 + `allowedLevels`/`minLevel` 互斥检查（同设 → 400）。空数组/空串 = 关闭。
- `register()` 级别块改成 `if (minLevel) … else if (allowedLevels) …`（`levelWeight` 比较）；新增性别块（`allowedGenders` 非空时 gender 须在集合，**不公开/空 → 拦**）。
- **迟到取消 = 缺席**：`cancel()` 在 `mine.cancelledAt=now` 后，若 `wasConfirmed && rules.cancelDeadlineHours && now > startTime − hours·3600000` → 设 `mine.attended=false`。该 reg 是 `cancelled` 但带 `attended=false`，被 `register()` 的禁报扫描（`r.attended===false`，不看 status）命中。**候补上位不受影响**。
- **详情页警告横幅**：`detail.rules.noShowBanDays` 生效时显示，文案按有无 `cancelDeadlineHours` 切换；`load()` 把 `d.rules` 下发。
- 兼容：既有活动 `rules`（仅 `noShowBanDays`/`allowedLevels`）行为不变；前端级别 UI 从布尔开关改成三态 picker（关/指定水平/某级以上），`loadForEdit` 据有无 `minLevel`/`allowedLevels` 回填模式。
- 同 Phase 4：缺席禁报要等原活动 `startTime` 过后才在新报名命中；缺席判定仍依赖 Phase 3 签到或本阶段的迟到取消。

**Phase 5（轮转调度）的实现要点：**
- **数据模型**：`activity.rotation = {courts, rounds, levelMode, fixedPairs, schedule, resting, generatedAt}`（覆盖式更新；`publicActivity` 透出）。`schedule` 是**生成时快照**（存当时的昵称/水平，后续资料变化不刷新；重新生成才更新）。
- **算法** `generateRotation(players, {courts, rounds, levelMode, fixedPairs, matchFormat})` **纯函数**（无 store，TDD）：逐轮贪心——上一轮休息者本轮**必上场**（满足"不连休"硬约束；当**人数 > 8×场数**避不开时，按 `gamesPlayed` 最少取 `4×courts` 个、其余无奈连休，不报错）；剩余名额按"上场次数最少优先"补（公平，软）；分场：`homogeneous`=按 weight 连续切片（同质）/`balanced`=蛇形；固定搭档被切片切开时单遍交换归拢（软）。**连打不限**。`players < 4×courts` → 400（填不满）。**赛制** `matchFormat`（`any`缺省/`mens`/`womens`/`mixed`）：分场时先 `extractFormatCourt` 按性别抽 1 场赛制场（当轮上场者够才抽，不够退回水平分），**选人/公平/不连休完全不动**；少数性别+少场地时该场可能很少出现（已知限制）。
- **端点**：`POST/GET/DELETE /api/activities/:id/rotation`。POST/DELETE 仅发起人（403 否则）；GET 公开（`optionalAuth`）。**池 = confirmed 且 `attended !== false`**（开赛后未签到者默认到场、已含；显式"缺"排除）——`setRotation` 里 reg 与 entry 配对过滤保对齐。
- **前端**：详情页"水平分组"卡的模式 picker 加「轮转表」；输入场数/轮数/水平模式；固定搭档用"点1人→点1人配对"勾选（`rotFixed` 二维 + `rotFixedFlat` 平铺供 wxml 高亮）；生成后展示 R 轮×C 场表（名字带**报名序号**「N-名字」，`_injectRotationNo` 按 confirmed 顺序注入）；可重新生成/清除。**导出 PNG**：`exportRotation()` 复用离屏 `#poster` canvas（动态设 buffer 高度）画整张轮转表 → `canvasToTempFilePath` → `previewImage`（长按存/转发）。
- **风险**：贪心非最优，极端人数/场数下公平或同质可能略不均，自用可接受；要更优后续上模拟退火（YAGNI）。

## 陷阱与非显而易见的事

- **测试是针对 `logic.js` 的单元级**（用内存 `Store`），不经过 HTTP。要验证 HTTP 层/路由，`curl` 正在跑的服务器；后端有请求日志中间件（跳过 health 与 OPTIONS），每个请求一行 `方法 路径 -> 状态 (耗时)`。
- **Linux 开发者工具的 `<picker>` 滚轮在 Wayland 下不滚动**（运行时缺陷，非代码 bug）。日历/时间选择器要在**真机**测；日志干净无错即属此情况。
- **别用 `pkill -f 'node src/index.js'`**——会匹配到命令自身、连带杀掉 shell（退出码 144）。停后台服务用它的任务句柄 / `kill <pid>`。
- **devMode 身份**：一台设备 = 一个 openid。测「多人报名/候补」要么换设备/清 storage 换身份，要么用 `curl` 以不同 `devUserId` 模拟他人。
- **生产部署**见 `DEPLOY.md`：必须 HTTPS + 备案域名，后端 `HOST=127.0.0.1` 走 Nginx 反代，`DATA_FILE` 用代码目录外的绝对路径（重新部署不丢数据）。
