const { request } = require('../../utils/request');
const { ensureLogin } = require('../../utils/auth');
const fmt = require('../../utils/format');

Page({
  data: {
    activities: [],
    loading: true,
    feedMode: 'relevant', // 'relevant' | 'all'
    fellBack: false,      // relevant 为空 → 正在显示 all
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
    this.setData({ feedMode, fellBack: false });
    await this.load();
  },

  async load() {
    try {
      this.setData({ loading: true });
      let list = await request('GET', '/api/activities/feed?mode=' + this.data.feedMode);
      let fellBack = false;
      // 相关为空 → 自动回退全部，避免新用户/冷启动空白。
      if (this.data.feedMode === 'relevant' && list.length === 0) {
        list = await request('GET', '/api/activities/feed?mode=all');
        fellBack = list.length > 0;
      }
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
      this.setData({ activities, loading: false, fellBack });
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
