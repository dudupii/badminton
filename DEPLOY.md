# 生产部署指南

目标：把羽毛球报名小程序从「开发环境」发布到「正式可用」。开发环境是 HTTP + 局域网 IP + devMode；**生产必须是 HTTPS + 公网域名 + 真实微信凭证**。

---

## 一、后端上线（HTTPS，必须）

### 1. 准备服务器与域名
- 一台云主机（任意厂商），有公网 IP。
- 一个域名，如 `badminton.example.com`，A 记录指向服务器 IP。
- 服务器装好：Node.js ≥ 18、Nginx、Certbot（Let's Encrypt）。

### 2. 部署代码 + 依赖
```bash
sudo mkdir -p /opt/badminton && sudo chown $USER /opt/badminton
git clone <你的仓库地址> /opt/badminton       # 或 scp 上传
cd /opt/badminton/server
npm install --omit=dev
```

### 3. 配置生产环境变量
```bash
cp .env.example .env
```
编辑 `.env`：
```ini
PORT=3000
HOST=127.0.0.1                 # 走 Nginx 反代，只绑回环
CORS_ORIGIN=*
DATA_FILE=/opt/badminton/data/db.json   # 绝对路径，独立于代码目录，避免重新部署丢数据
TOKEN_SECRET=<运行下面命令生成>
WX_APPID=wx402c1f46a4c59c64    # 你的真实 AppID（关闭 devMode）
WX_SECRET=<小程序后台的 Secret>
WX_ENV_VERSION=release
```
生成强随机 TOKEN_SECRET：
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
> Secret 只放在服务器 `.env`，**不要**进代码仓库或前端。当前仓库不含任何 Secret，正确。

### 4. 设为系统服务（开机自启 + 崩溃重启）
```bash
sudo cp deploy/badminton-server.service /etc/systemd/system/
# 编辑该文件，确认 User / WorkingDirectory 与你的部署一致
sudo systemctl daemon-reload
sudo systemctl enable --now badminton-server
sudo systemctl status badminton-server      # 应为 active(running)
curl http://127.0.0.1:3000/api/health        # 本机自测
```

### 5. 配 Nginx + HTTPS
```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/badminton
sudo ln -s /etc/nginx/sites-available/badminton /etc/nginx/sites-enabled/badminton
# 把配置里的 badminton.example.com 全部替换为你的域名
sudo certbot --nginx -d badminton.example.com     # 申请免费证书
sudo nginx -t && sudo systemctl reload nginx
curl https://badminton.example.com/api/health     # 公网自测，应返回 {"ok":true,...}
```

### 6. 改前端生产域名
编辑 `miniprogram/utils/config.js`，把 `PROD_URL` 改成你的域名：
```js
const PROD_URL = 'https://badminton.example.com';
```
（`DEV_URL` 保持开发机局域网地址即可，开发环境会自动用它。）

---

## 二、小程序后台配置

登录 [mp.weixin.qq.com](https://mp.weixin.qq.com)：

1. **开发管理 → 开发设置 → 服务器域名 → 服务器域名(request)**
   添加 `https://badminton.example.com`（不带端口/路径）。二维码功能还需配置 **downloadFile 合法域名**（同域，保存二维码用）。
2. **开发管理 → 开发设置** 里拿到 `AppID` 和 `AppSecret`（AppSecret 即 `.env` 的 `WX_SECRET`）。

---

## 三、上传 → 审核 → 发布

1. 微信开发者工具打开项目，**编译** 确认无报错。
2. 工具栏点 **「上传」** → 版本号（如 `1.0.0`）+ 描述 → 上传为「开发版」。
3. 后台 **版本管理** → 选开发版 → **「提交审核」** → 填类目、功能页。
4. 审核通过后 → **版本管理** → 审核通过版本 → **「发布」**。

> 发布前务必在真机走一遍完整流程（创建→报名→候补→取消上位→二维码扫码），审核员会真机体验。

---

## 四、先发「体验版」给球友试用（不用等审核）

正式发布前，让球友先玩起来：

1. 后台 **版本管理** → 把上传的开发版 **选为「体验版」**。
2. **成员管理 → 体验成员** 添加球友微信号（个人主体约 15 个名额）。
3. 体验成员扫「体验版二维码」或收你转发的活动卡片即可报名。
4. 此时小程序运行在 `trial` 环境 → `config.js` 自动用 `PROD_URL`（公网 HTTPS 后端），所以体验版**也需要后端已上线**。

---

## 五、检查清单

- [ ] 后端跑在 `https://你的域名`，`/api/health` 返回 ok
- [ ] `.env` 设了真实 `WX_APPID` / `WX_SECRET`，`devMode=false`
- [ ] `TOKEN_SECRET` 是强随机串
- [ ] `DATA_FILE` 在代码目录之外（部署不丢数据）
- [ ] `HOST=127.0.0.1`，仅 Nginx 对外
- [ ] systemd 服务 `active(running)` 且开机自启
- [ ] 小程序后台已配 request / downloadFile 合法域名
- [ ] `config.js` 的 `PROD_URL` 改成你的域名
- [ ] 真机体验版走通：登录、创建、报名、候补、取消上位、二维码
