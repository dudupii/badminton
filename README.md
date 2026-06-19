# 羽毛球活动报名小程序

一个微信小程序 + 后端服务，用于**组织羽毛球活动并管理报名**：

- 🏸 任何人（登录后）都能发起一场活动，设置时间、地点和**名额**
- 📝 球友用**微信身份**一键报名
- 🔢 名额满后自动转为**候补**，按报名先后排序
- 🔁 有人**取消**时，候补第一名**自动上位**；上位后推送**订阅消息**通知
- 👥 实时查看正式名单 / 候补名单 / 自己的状态
- 🔗 每个活动自动生成**二维码 / 小程序码**，可转发或扫码报名
- 🎨 **复制上一场**：一键带出历史活动，时间自动顺延 7 天（同星期同时段）
- 🏷️ **水平 / 性别标签**：个人资料可选水平与性别，名单显示徽章并汇总男女人数
- 🖼️ **活动海报**：详情页一键生成运动主题海报（绿底 + 🏸 + 信息 + 二维码），长按可保存/分享

```
badminton/
├── server/              # Node + Express 后端（报名、名额、候补、上位逻辑）
│   ├── src/
│   │   ├── index.js     # Express 路由入口
│   │   ├── logic.js     # 领域逻辑（可测试，纯事务）
│   │   ├── store.js     # JSON 文件持久化 + 写锁（保证原子性）
│   │   ├── auth.js      # 微信 code2session + HMAC token
│   │   ├── wxapi.js     # access_token + 小程序码 (wxacode.getUnlimited)
│   │   └── config.js
│   └── tests/           # node:test 单元/逻辑测试
├── miniprogram/         # 微信小程序前端
│   ├── app.{js,json,wxss}
│   ├── utils/           # request / auth(wx.login) / format / config
│   └── pages/
│       ├── index/       # 活动列表
│       ├── detail/      # 活动详情 + 报名/取消 + 名单
│       ├── create/      # 发起活动
│       └── profile/     # 我的（微信昵称/头像 + 我的报名）
└── project.config.json  # 微信开发者工具配置
```

---

## 一、启动后端

```bash
cd server
npm install
npm start          # 默认 http://localhost:3000
```

### 两种登录模式

| 模式 | 何时生效 | 行为 |
|------|----------|------|
| **开发模式** | 未配置 `WX_APPID` / `WX_SECRET` | 调用 `wx.login` 后，服务端用客户端生成的 `devUserId` 派生一个稳定 openid，**无需任何微信凭证**即可联调 |
| **正式模式** | `.env` 里填了 `WX_APPID` 和 `WX_SECRET` | 服务端走真实的 `code2session` 拿到 openid，用于生产 |

复制配置：

```bash
cd server
cp .env.example .env
# 正式部署时填写：
#   WX_APPID=你的小程序AppID
#   WX_SECRET=你的小程序Secret
#   WX_ENV_VERSION=release   # develop | trial | release（二维码进入的版本）
#   TOKEN_SECRET=换成一长串随机字符串
```

### 运行测试

```bash
cd server
npm test
```

覆盖：名额截断、候补排序、取消后自动上位（FIFO）、重复报名拦截、取消后再报名、过期活动拦截、输入校验、仅发起人可关闭、**邀请码生成与按码查询**、token 签名校验。

---

## 二、打开小程序（微信开发者工具）

1. 打开 **微信开发者工具**，导入本项目根目录 `badminton/`。
2. AppID 选择「**测试号**」或填入你自己的小程序 AppID（`project.config.json` 默认 `touristappid`）。
3. **关键**：右上角「详情」→「本地设置」→ 勾选 **「不校验合法域名…」**，否则无法访问 `http://localhost:3000`。
4. 修改 `miniprogram/utils/config.js` 里的 `BASE_URL` 指向你的后端地址（本机联调保持 `http://localhost:3000` 即可）。
5. 后端 `npm start` 后，在模拟器里即可：发起活动 → 报名 → 名额满后候补 → 取消触发上位。

> 生产环境 `BASE_URL` 必须是 **HTTPS**，并在小程序管理后台「开发设置 → 服务器域名」中配置 request 合法域名。

---

## API 一览

| 方法 | 路径 | 说明 | 鉴权 |
|------|------|------|------|
| POST | `/api/auth/login` | `wx.login` 的 code 换 token | 公开 |
| GET  | `/api/user/me` | 当前用户信息（含 level/gender） | 必须 |
| PATCH| `/api/user/me` | 更新昵称/头像/水平/性别 | 必须 |
| GET  | `/api/activities` | 活动列表 | 公开 |
| POST | `/api/activities` | 发起活动 | 必须 |
| GET  | `/api/activities/created-by/me` | 我发起的活动（复制上一场用） | 必须 |
| GET  | `/api/activities/:id` | 活动详情 + 名单 + 我的状态 | 可选 |
| GET  | `/api/activities/by-code/:code` | 按**邀请码**查活动（扫码进入时用） | 可选 |
| GET  | `/api/activities/:id/qrcode` | 活动二维码图片（`image/png`） | 公开 |
| PATCH| `/api/activities/:id` | 发起人关闭/重开报名 | 必须(发起人) |
| POST | `/api/activities/:id/register` | 报名（满则候补） | 必须 |
| POST | `/api/activities/:id/cancel` | 取消报名（触发候补上位 + 上位订阅通知） | 必须 |
| GET  | `/api/registrations/me` | 我的报名记录 | 必须 |
| POST | `/api/subscriptions` | 记录一次性订阅授权（候补上位通知） | 必须 |

### 名额与候补规则

- 报名时：正式名额未满 → **confirmed**；已满 → **waitlist**（按报名时间排序）。
- 取消正式名额时：候补中**最早报名**者自动升为 confirmed；取消候补名额不触发上位。
- 同一活动不可重复报名；取消后可再次报名。
- 活动开始后或被发起人关闭后，无法报名。

### 二维码 / 邀请报名

每个活动创建时会生成一个 6 位**邀请码**（如 `PHH5MU`），并据此生成二维码：

- **生产模式**（配置了 `WX_APPID`/`WX_SECRET`）：调用官方 `wxacode.getUnlimited` 生成真正的**小程序码**。别的微信用户用「扫一扫」即可**直接进入活动详情页**报名——`scene` 即邀请码，详情页 `onLoad` 通过 `options.scene` 读取并按码加载活动。
- **开发模式**：生成一张占位二维码（品牌绿码），先跑通 UI；填上凭证后自动切换为真实小程序码。
- 详情页可**保存二维码到相册**，或点「转发给好友」把活动卡片发到微信群——对方点击同样进入详情页报名。
- `WX_ENV_VERSION`（`develop`/`trial`/`release`）决定扫码进入开发版/体验版/正式版；发布前用 `trial` 测试。

> 生产环境还需在小程序管理后台「开发设置 → 服务器域名」配置 **downloadFile 合法域名**（保存二维码时用 `wx.downloadFile`）。

---

## 设计说明

- **原子性**：后端单进程，所有写操作经过串行写锁（`store.txn`），因此名额计数与「取消→上位」不会出现竞态。
- **零外部数据库**：默认用 JSON 文件存储（`server/data/db.json`）。如需替换为 MySQL/MongoDB，只需改写 `store.js`。
- **无密码**：身份完全基于微信 openid；token 使用 HMAC-SHA256 自签。运行时依赖仅 `express` + `qrcode`（开发模式占位码用）。

## 后续可扩展

- 接入微信支付处理场地费分摊
- 订阅消息：**候补上位通知已实现**；后续可加「报名成功」「活动开始前提醒」等模板
- 头像持久化（当前 `chooseAvatar` 仅本地预览，需配合对象存储上传）
- 管理员/群组权限；「复制上一场」之外的可配置周期模板

### 候补上位订阅消息（可选，需生产凭证）

取消正式名额触发候补上位时，后端会向上位者发送一次性订阅消息。启用需在**正式模式**（配置 `WX_APPID`/`WX_SECRET`）下：

1. 小程序后台「订阅消息」创建模板，记下 `templateId`。
2. 后端 `.env` 填 `WX_PROMOTE_TPL=<templateId>`，并按真实模板字段调整 `server/src/index.js` 里 `thing1/time2/thing3` 的字段名。
3. 前端 `miniprogram/utils/config.js` 里把 `SUBSCRIBE_TEMPLATES.promote` 从占位 `PROMOTE_TPL_ID` 改成同一个 `templateId`。

> 占位未替换 / 开发模式下，前端自动跳过订阅请求、后端不发送，不影响报名与上位逻辑。
