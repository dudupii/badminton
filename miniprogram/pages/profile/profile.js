const { request } = require('../../utils/request');
const { ensureLogin } = require('../../utils/auth');
const fmt = require('../../utils/format');

Page({
  data: {
    user: { nickname: '', avatarUrl: '' },
    regs: [],
    loading: true,
  },

  async onShow() {
    try {
      await ensureLogin();
    } catch (e) {
      wx.showToast({ title: '登录失败：' + e.message, icon: 'none' });
    }
    await Promise.all([this.loadMe(), this.loadRegs()]);
  },

  async loadMe() {
    try {
      const u = await request('GET', '/api/user/me');
      this.setData({ user: u });
      getApp().globalData.userInfo = u;
    } catch (e) {
      /* ignore */
    }
  },

  async loadRegs() {
    try {
      const list = await request('GET', '/api/registrations/me');
      list.forEach((r) => {
        r.timeText = fmt.dateTime(r.activity.startTime);
      });
      this.setData({ regs: list, loading: false });
    } catch (e) {
      this.setData({ loading: false });
    }
  },

  onChooseAvatar(e) {
    this.setData({ 'user.avatarUrl': e.detail.avatarUrl });
    this.saveProfile();
  },

  onNicknameInput(e) {
    this.setData({ 'user.nickname': e.detail.value });
  },

  onNicknameBlur() {
    this.saveProfile();
  },

  async saveProfile() {
    try {
      await request('PATCH', '/api/user/me', {
        nickname: this.data.user.nickname,
        avatarUrl: this.data.user.avatarUrl,
      });
    } catch (e) {
      /* ignore profile save errors silently */
    }
  },

  goDetail(e) {
    wx.switchTab({ url: '/pages/index/index' });
    setTimeout(() => {
      wx.navigateTo({ url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id });
    }, 100);
  },
});
