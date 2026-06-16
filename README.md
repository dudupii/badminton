# 羽毛球活动报名小程序

一个微信小程序 + 后端服务，用于**组织羽毛球活动并管理报名**：

- 🏸 任何人（登录后）都能发起一场活动，设置时间、地点和**名额**
- 📝 球友用**微信身份**一键报名
- 🔢 名额满后自动转为**候补**，按报名先后排序
- 🔁 有人**取消**时，候补第一名**自动上位**
- 👥 实时查看正式名单 / 候补名单 / 自己的状态

```
badminton/
├── server/              # Node + Express 后端（报名、名额、候补、上位逻辑）
│   ├── src/
│   │   ├── index.js     # Express 路由入口
│   │   ├── logic.js     # 领域逻辑（可测试，纯事务）
│   │   ├── store.js     # JSON 文件持久化 + 写锁（保证原子性）
│   │   ├── auth.js      # 微信 code2session + HMAC token
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
#   TOKEN_SECRET=换成一长串随机字符串
```

### 运行测试

```bash
cd server
npm test
```

覆盖：名额截断、候补排序、取消后自动上位（FIFO）、重复报名拦截、取消后再报名、过期活动拦截、输入校验、仅发起人可关闭、token 签名校验。

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
| GET  | `/api/user/me` | 当前用户信息 | 必须 |
| PATCH| `/api/user/me` | 更新昵称/头像 | 必须 |
| GET  | `/api/activities` | 活动列表 | 公开 |
| POST | `/api/activities` | 发起活动 | 必须 |
| GET  | `/api/activities/:id` | 活动详情 + 名单 + 我的状态 | 可选 |
| PATCH| `/api/activities/:id` | 发起人关闭/重开报名 | 必须(发起人) |
| POST | `/api/activities/:id/register` | 报名（满则候补） | 必须 |
| POST | `/api/activities/:id/cancel` | 取消报名（触发候补上位） | 必须 |
| GET  | `/api/registrations/me` | 我的报名记录 | 必须 |

### 名额与候补规则

- 报名时：正式名额未满 → **confirmed**；已满 → **waitlist**（按报名时间排序）。
- 取消正式名额时：候补中**最早报名**者自动升为 confirmed；取消候补名额不触发上位。
- 同一活动不可重复报名；取消后可再次报名。
- 活动开始后或被发起人关闭后，无法报名。

---

## 设计说明

- **原子性**：后端单进程，所有写操作经过串行写锁（`store.txn`），因此名额计数与「取消→上位」不会出现竞态。
- **零外部数据库**：默认用 JSON 文件存储（`server/data/db.json`）。如需替换为 MySQL/MongoDB，只需改写 `store.js`。
- **无密码**：身份完全基于微信 openid；token 使用 HMAC-SHA256 自签，无额外依赖（唯一运行时依赖是 `express`）。

## 后续可扩展

- 接入微信支付处理场地费分摊
- 模板消息/订阅消息：报名成功、候补上位、活动开始前提醒
- 头像持久化（当前 `chooseAvatar` 仅本地预览，需配合对象存储上传）
- 管理员/群组权限、重复活动模板
