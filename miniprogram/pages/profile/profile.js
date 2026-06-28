const { request } = require('../../utils/request');
const { ensureLogin } = require('../../utils/auth');
const { BASE_URL } = require('../../utils/config');
const fmt = require('../../utils/format');
const { LEVELS, LEVEL_DESC } = require('../../utils/levels');

Page({
  data: {
    user: { nickname: '', avatarUrl: '', level: '', gender: '' },
    levelOptions: LEVELS.map((n) => ({ name: n, desc: LEVEL_DESC[n] })),
    genders: ['男', '女'],
    regs: [],
    myActs: [],
    loading: true,
  },

  async onShow() {
    try {
      await ensureLogin();
    } catch (e) {
      wx.showToast({ title: '登录失败：' + e.message, icon: 'none' });
    }
    await Promise.all([this.loadMe(), this.loadRegs(), this.loadMyActs()]);
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
        r.timeText = fmt.friendlyTime(r.activity.startTime);
      });
      this.setData({ regs: list, loading: false });
    } catch (e) {
      this.setData({ loading: false });
    }
  },

  async loadMyActs() {
    try {
      const list = await request('GET', '/api/activities/created-by/me');
      list.forEach((a) => {
        a.timeText = fmt.friendlyTime(a.startTime);
      });
      this.setData({ myActs: list });
    } catch (e) {
      /* ignore */
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
    const level = e.detail.value; // radio-group 直接给 level 名
    this.setData({ 'user.level': level });
    this.saveProfile();
  },
  onGenderChange(e) {
    this.setData({ 'user.gender': e.detail.value }); // radio-group 直接给值
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
    wx.navigateTo({ url: '/pages/detail/detail?id=' + e.currentTarget.dataset.id });
  },
  goClubs() {
    wx.navigateTo({ url: '/pages/clubs/clubs' });
  },

  goStats() {
    wx.navigateTo({ url: '/pages/stats/stats' });
  },
});
