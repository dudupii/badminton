const { request } = require('../../utils/request');
const { ensureLogin } = require('../../utils/auth');
const fmt = require('../../utils/format');

Page({
  data: {
    id: '',
    detail: null,
    loading: true,
    isCreator: false,
    canRegister: false,
    canCancel: false,
    isPast: false,
    myWaitPos: 0,
  },

  onLoad(q) {
    this.setData({ id: q.id });
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
      const d = await request('GET', '/api/activities/' + this.data.id);
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
        detail: d,
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
});
