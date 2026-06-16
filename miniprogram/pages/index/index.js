const { request } = require('../../utils/request');
const { ensureLogin } = require('../../utils/auth');
const fmt = require('../../utils/format');

Page({
  data: {
    activities: [],
    loading: true,
  },

  async onShow() {
    try {
      await ensureLogin();
    } catch (e) {
      wx.showToast({ title: '登录失败：' + e.message, icon: 'none' });
    }
    await this.load();
  },

  async onPullDownRefresh() {
    await this.load();
    wx.stopPullDownRefresh();
  },

  async load() {
    try {
      this.setData({ loading: true });
      const list = await request('GET', '/api/activities');
      const now = Date.now();
      const activities = list.map((a) => ({
        ...a,
        timeText: fmt.dateTime(a.startTime),
        fillText: a.confirmedCount + '/' + a.capacity,
        isFull: a.confirmedCount >= a.capacity,
        isPast: a.startTime && a.startTime < now,
      }));
      this.setData({ activities, loading: false });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  goDetail(e) {
    wx.navigateTo({ url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id });
  },

  goCreate() {
    wx.navigateTo({ url: '/pages/create/create' });
  },
});
