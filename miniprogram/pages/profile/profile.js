const { request } = require('../../utils/request');
const { ensureLogin } = require('../../utils/auth');
const { BASE_URL } = require('../../utils/config');
const fmt = require('../../utils/format');

Page({
  data: {
    user: { nickname: '', avatarUrl: '', level: '', gender: '' },
    levels: ['新手', '初级', '中级', '高级'],
    genders: ['男', '女', '不公开'],
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
      // avatars are stored server-relative; resolve for <image> display
      if (u.avatarUrl && u.avatarUrl.startsWith('/')) u.avatarUrl = BASE_URL + u.avatarUrl;
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

  async onChooseAvatar(e) {
    const tempPath = e.detail.avatarUrl;
    this.setData({ 'user.avatarUrl': tempPath }); // local preview immediately
    try {
      const file = await new Promise((res, rej) =>
        wx.getFileSystemManager().readFile({ filePath: tempPath, encoding: 'base64', success: res, fail: rej })
      );
      const ext = (tempPath.split('.').pop() || 'png').toLowerCase();
      const r = await request('POST', '/api/user/me/avatar', { avatar: file.data, ext });
      this.setData({ 'user.avatarUrl': BASE_URL + r.avatarUrl });
      getApp().globalData.userInfo = this.data.user;
    } catch (e) {
      wx.showToast({ title: '头像上传失败', icon: 'none' });
    }
  },

  onNicknameInput(e) {
    this.setData({ 'user.nickname': e.detail.value });
  },

  onNicknameBlur() {
    this.saveProfile();
  },

  onLevelChange(e) {
    this.setData({ 'user.level': this.data.levels[e.detail.value] });
    this.saveProfile();
  },
  onGenderChange(e) {
    this.setData({ 'user.gender': this.data.genders[e.detail.value] });
    this.saveProfile();
  },

  async saveProfile() {
    try {
      const u = this.data.user;
      // avatarUrl is managed by the upload endpoint, not here.
      await request('PATCH', '/api/user/me', {
        nickname: u.nickname,
        level: u.level,
        gender: u.gender,
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
