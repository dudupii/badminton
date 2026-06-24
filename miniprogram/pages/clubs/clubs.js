const { request } = require('../../utils/request');
const { ensureLogin } = require('../../utils/auth');

Page({
  data: {
    clubs: [],
    loading: true,
    newName: '',
    joinCode: '',
    selectedClub: null,
    clubActs: [],
  },

  async onShow() {
    try { await ensureLogin(); } catch (e) {}
    await this.loadClubs();
  },

  async loadClubs() {
    try {
      this.setData({ clubs: await request('GET', '/api/clubs/mine'), loading: false });
    } catch (e) { this.setData({ loading: false }); }
  },

  onNewName(e) { this.setData({ newName: e.detail.value }); },
  onJoinCode(e) { this.setData({ joinCode: e.detail.value }); },

  async createClub() {
    const name = (this.data.newName || '').trim();
    if (!name) return wx.showToast({ title: '请填群名', icon: 'none' });
    try {
      await request('POST', '/api/clubs', { name });
      this.setData({ newName: '' });
      this.loadClubs();
      wx.showToast({ title: '群已创建', icon: 'success' });
    } catch (e) { wx.showToast({ title: e.message, icon: 'none' }); }
  },

  async joinClub() {
    const code = (this.data.joinCode || '').trim().toUpperCase();
    if (!code) return wx.showToast({ title: '请填邀请码', icon: 'none' });
    try {
      await request('POST', '/api/clubs/' + code + '/join');
      this.setData({ joinCode: '' });
      this.loadClubs();
      wx.showToast({ title: '已加入', icon: 'success' });
    } catch (e) { wx.showToast({ title: e.message, icon: 'none' }); }
  },

  copyCode(e) {
    wx.setClipboardData({
      data: e.currentTarget.dataset.code,
      success: () => wx.showToast({ title: '邀请码已复制', icon: 'none' }),
    });
  },

  async openClub(e) {
    const club = this.data.clubs.find((c) => c.id === e.currentTarget.dataset.id);
    if (!club) return;
    this.setData({ selectedClub: club, clubActs: [] });
    try {
      const list = await request('GET', '/api/activities?clubId=' + club.id);
      this.setData({ clubActs: list || [] });
    } catch (e) {}
  },

  closeClub() {
    this.setData({ selectedClub: null });
  },

  goDetail(e) {
    const id = e.currentTarget.dataset.id;
    this.setData({ selectedClub: null });
    wx.navigateTo({ url: '/pages/detail/detail?id=' + id });
  },

  async leaveClub(e) {
    const id = e.currentTarget.dataset.id;
    const confirm = await new Promise((res) => {
      wx.showModal({ title: '退群', content: '确定退出该群？', confirmColor: '#dc2626', success: (m) => res(m.confirm) });
    });
    if (!confirm) return;
    try {
      await request('POST', '/api/clubs/' + id + '/leave');
      this.loadClubs();
      wx.showToast({ title: '已退群', icon: 'success' });
    } catch (e) { wx.showToast({ title: e.message, icon: 'none' }); }
  },

  async deleteClub(e) {
    const id = e.currentTarget.dataset.id;
    const confirm = await new Promise((res) => {
      wx.showModal({ title: '删除群', content: '删除后不可恢复，确定？', confirmColor: '#dc2626', success: (m) => res(m.confirm) });
    });
    if (!confirm) return;
    try {
      await request('DELETE', '/api/clubs/' + id);
      this.loadClubs();
      wx.showToast({ title: '已删除', icon: 'success' });
    } catch (e) { wx.showToast({ title: e.message, icon: 'none' }); }
  },
});
