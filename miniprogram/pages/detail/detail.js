const { request } = require('../../utils/request');
const { ensureLogin } = require('../../utils/auth');
const { BASE_URL, SUBSCRIBE_TEMPLATES } = require('../../utils/config');
const fmt = require('../../utils/format');

Page({
  data: {
    id: '',
    scene: '', // invite code, present when opened by scanning the activity QR
    detail: null,
    qrcodeUrl: '',
    loading: true,
    isCreator: false,
    canRegister: false,
    canCancel: false,
    isPast: false,
    myWaitPos: 0,
    genderCount: { male: 0, female: 0 },
  },

  onLoad(q) {
    // q.id: normal in-app navigation; q.scene: arrived via scanned mini-program code.
    const scene = q.scene ? decodeURIComponent(q.scene) : '';
    this.setData({ id: q.id || '', scene });
  },

  async onShow() {
    try {
      await ensureLogin();
    } catch (e) {
      wx.showToast({ title: '登录失败：' + e.message, icon: 'none' });
    }
    await this.load();
  },

  async load() {
    try {
      this.setData({ loading: true });
      const d = await request(
        'GET',
        this.data.scene
          ? '/api/activities/by-code/' + encodeURIComponent(this.data.scene)
          : '/api/activities/' + this.data.id
      );
      const app = getApp();
      const me = app.globalData.openid;

      d.timeText = fmt.dateTime(d.startTime);
      d.endText = d.endTime ? fmt.dateTime(d.endTime) : '';

      const now = Date.now();
      const isPast = !!(d.startTime && d.startTime < now);
      const myStatus = d.myStatus;
      const myWaitPos =
        myStatus === 'waitlist'
          ? d.waitlist.findIndex((x) => x.openid === me) + 1
          : 0;

      this.setData({
        id: d.id,
        detail: d,
        qrcodeUrl: BASE_URL + '/api/activities/' + d.id + '/qrcode',
        loading: false,
        isCreator: me === d.createdBy,
        isPast,
        myWaitPos,
        canRegister: !myStatus && d.status === 'open' && !isPast,
        canCancel: !!myStatus,
        genderCount: {
          male: d.confirmed.filter((x) => x.gender === '男').length,
          female: d.confirmed.filter((x) => x.gender === '女').length,
        },
      });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  async doRegister() {
    // Real (non-placeholder) templates the user may authorize in one prompt.
    const tpls = ['promote', 'registered', 'remind']
      .map((k) => SUBSCRIBE_TEMPLATES[k])
      .filter((t) => t && !t.endsWith('_TPL_ID'));
    let accepted = null;
    if (tpls.length) {
      try {
        accepted = await new Promise((res) =>
          wx.requestSubscribeMessage({ tmplIds: tpls, success: res, fail: () => res(null) })
        );
      } catch (e) {
        accepted = null;
      }
    }
    const give = (tpl) =>
      accepted && accepted[tpl] === 'accept'
        ? request('POST', '/api/subscriptions', { templateId: tpl }).catch(() => {})
        : Promise.resolve();
    try {
      // Grant the "registered" credit BEFORE register so the route can consume
      // it and send the success message in the same request.
      if (accepted && accepted[SUBSCRIBE_TEMPLATES.registered] === 'accept') {
        await give(SUBSCRIBE_TEMPLATES.registered);
      }
      const r = await request('POST', '/api/activities/' + this.data.id + '/register');
      // Future-event credits (promotion / reminder) are granted after success.
      if (accepted && accepted[SUBSCRIBE_TEMPLATES.promote] === 'accept') {
        await give(SUBSCRIBE_TEMPLATES.promote);
      }
      if (accepted && accepted[SUBSCRIBE_TEMPLATES.remind] === 'accept') {
        await give(SUBSCRIBE_TEMPLATES.remind);
      }
      wx.showToast({ title: r.message, icon: 'none', duration: 2000 });
      this.load();
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  async doCancel() {
    const confirm = await new Promise((resolve) => {
      wx.showModal({
        title: '取消报名',
        content: '确定取消吗？如果是正式名额，候补第一名将自动上位。',
        confirmColor: '#dc2626',
        success: (m) => resolve(m.confirm),
      });
    });
    if (!confirm) return;

    try {
      const r = await request('POST', '/api/activities/' + this.data.id + '/cancel');
      let msg = '已取消报名';
      if (r.promoted) {
        msg = '已取消，候补的「' + (r.promoted.nickname || '球友') + '」已自动上位';
      }
      wx.showToast({ title: msg, icon: 'none', duration: 2500 });
      this.load();
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  async toggleStatus() {
    const d = this.data.detail;
    const next = d.status === 'open' ? 'closed' : 'open';
    try {
      await request('PATCH', '/api/activities/' + this.data.id, { status: next });
      this.load();
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  goEdit() {
    wx.navigateTo({ url: '/pages/create/create?id=' + this.data.id });
  },

  async deleteActivity() {
    const confirm = await new Promise((resolve) => {
      wx.showModal({
        title: '删除活动',
        content: '将删除该活动及其所有报名记录，且不可撤销。确定？',
        confirmText: '删除',
        confirmColor: '#dc2626',
        success: (m) => resolve(m.confirm),
      });
    });
    if (!confirm) return;
    try {
      await request('DELETE', '/api/activities/' + this.data.id);
      wx.showToast({ title: '已删除', icon: 'success' });
      setTimeout(() => wx.switchTab({ url: '/pages/index/index' }), 600);
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  copyLocation() {
    if (this.data.detail && this.data.detail.location) {
      wx.setClipboardData({ data: this.data.detail.location });
    }
  },

  // Forward the activity to a WeChat chat — recipient taps the card to open
  // this page and sign up. Works in dev/trial (testers) without a QR.
  onShareAppMessage() {
    const d = this.data.detail;
    return {
      title: d ? `邀请你参加：${d.title}` : '羽毛球活动报名',
      path: 'pages/detail/detail?id=' + this.data.id,
    };
  },

  async saveQrToAlbum() {
    if (!this.data.qrcodeUrl) return;
    try {
      const dl = await new Promise((res, rej) =>
        wx.downloadFile({ url: this.data.qrcodeUrl, success: res, fail: rej })
      );
      await new Promise((res, rej) => {
        wx.saveImageToPhotosAlbum({
          filePath: dl.tempFilePath,
          success: res,
          fail: (err) => {
            if (err.errMsg && err.errMsg.indexOf('auth deny') !== -1) {
              wx.showModal({
                title: '需要相册权限',
                content: '请在设置中开启"保存到相册"权限',
                confirmText: '去设置',
                success: (m) => {
                  if (m.confirm) wx.openSetting();
                },
              });
            }
            rej(err);
          },
        });
      });
      wx.showToast({ title: '已保存到相册', icon: 'success' });
    } catch (e) {
      wx.showToast({ title: '保存失败', icon: 'none' });
    }
  },

  async generatePoster() {
    const d = this.data.detail;
    if (!d) return;
    wx.showLoading({ title: '生成中' });
    try {
      // 1. 拉二维码图
      const dl = await new Promise((res, rej) =>
        wx.downloadFile({ url: this.data.qrcodeUrl, success: res, fail: rej })
      );
      // 2. 取 canvas 节点
      const { canvas, ctx, W, H } = await new Promise((res, rej) => {
        wx.createSelectorQuery()
          .select('#poster')
          .fields({ node: true, size: true })
          .exec((r) => (r && r[0] && r[0].node ? res(r[0]) : rej(new Error('canvas 不存在'))));
      }).then((info) => {
        const c = info.node;
        const ctx = c.getContext('2d');
        const dpr = wx.getSystemInfoSync().pixelRatio;
        c.width = info.width * dpr;
        c.height = info.height * dpr;
        ctx.scale(dpr, dpr);
        return { canvas: c, ctx, W: info.width, H: info.height };
      });

      // 3. 运动主题背景：绿渐变 + 🏸 水印
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#16a34a');
      g.addColorStop(1, '#065f46');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.font = '120px sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillText('🏸', W - 150, 170);

      // 4. 文案
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 30px sans-serif';
      this._wrapText(ctx, d.title || '羽毛球活动', 36, 90, W - 72, 38);
      ctx.font = '22px sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      let y = 220;
      ctx.fillText('⏰ ' + d.timeText, 36, y);
      y += 36;
      if (d.location) {
        ctx.fillText('📍 ' + d.location, 36, y);
        y += 36;
      }
      ctx.fillText('名额 ' + d.confirmedCount + '/' + d.capacity, 36, y);

      // 5. 二维码（加载图片后绘制并导出）
      const img = canvas.createImage();
      img.onload = () => {
        ctx.drawImage(img, W - 200, H - 230, 164, 164);
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.font = '18px sans-serif';
        ctx.fillText('扫码报名', W - 180, H - 44);
        wx.canvasToTempFilePath({
          canvas,
          success: (out) => {
            wx.hideLoading();
            wx.previewImage({ urls: [out.tempFilePath] }); // 长按可保存/分享
          },
          fail: () => {
            wx.hideLoading();
            wx.showToast({ title: '生成失败', icon: 'none' });
          },
        });
      };
      img.onerror = () => {
        wx.hideLoading();
        wx.showToast({ title: '二维码加载失败', icon: 'none' });
      };
      img.src = dl.tempFilePath;
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: e.message || '生成失败', icon: 'none' });
    }
  },

  _wrapText(ctx, text, x, y, maxWidth, lineHeight) {
    // 简易中文换行（按字符）
    let line = '';
    for (const ch of String(text)) {
      const test = line + ch;
      if (ctx.measureText(test).width > maxWidth && line) {
        ctx.fillText(line, x, y);
        line = ch;
        y += lineHeight;
      } else {
        line = test;
      }
    }
    if (line) ctx.fillText(line, x, y);
  },
});
