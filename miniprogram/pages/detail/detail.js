const { request } = require('../../utils/request');
const { ensureLogin } = require('../../utils/auth');
const { BASE_URL } = require('../../utils/config');
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
      });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  async doRegister() {
    try {
      const r = await request('POST', '/api/activities/' + this.data.id + '/register');
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
});
