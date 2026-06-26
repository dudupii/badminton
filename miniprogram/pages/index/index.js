const { request } = require('../../utils/request');
const { ensureLogin } = require('../../utils/auth');
const fmt = require('../../utils/format');

Page({
  data: {
    activities: [],
    loading: true,
    feedMode: 'relevant', // 'relevant' | 'all'
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

  async switchFeed(e) {
    const feedMode = e.currentTarget.dataset.mode;
    if (feedMode === this.data.feedMode) return;
    this.setData({ feedMode });
    await this.load();
  },

  async load() {
    try {
      this.setData({ loading: true });
      const list = await request('GET', '/api/activities/feed?mode=' + this.data.feedMode);
      const now = Date.now();
      const activities = list
        .map((a) => ({
          ...a,
          timeText: fmt.friendlyTime(a.startTime),
          fillText: a.confirmedCount + '/' + a.capacity,
          isFull: a.confirmedCount >= a.capacity,
          isPast: a.startTime && a.startTime < now,
        }))
        .sort((x, y) => {
          // 即将开始优先（最早最前），已结束沉底。
          if (x.isPast !== y.isPast) return x.isPast ? 1 : -1;
          return x.isPast ? y.startTime - x.startTime : x.startTime - y.startTime;
        });
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
