const { request } = require('../../utils/request');
const { ensureLogin } = require('../../utils/auth');

Page({
  data: { stats: [], loading: true },
  async onShow() {
    try {
      await ensureLogin();
    } catch (e) {}
    try {
      const list = await request('GET', '/api/stats/attendance');
      this.setData({ stats: list, loading: false });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },
});
