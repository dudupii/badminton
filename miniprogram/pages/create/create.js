const { request } = require('../../utils/request');

function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

function dateStr(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

Page({
  data: {
    title: '',
    location: '',
    description: '',
    capacity: 8,
    startDate: '',
    startTime: '19:00',
    endDate: '',
    endTime: '21:00',
    submitting: false,
  },

  onLoad() {
    const today = new Date();
    this.setData({
      startDate: dateStr(today),
      endDate: dateStr(today),
    });
  },

  onInput(e) {
    const { field } = e.currentTarget.dataset;
    this.setData({ [field]: e.detail.value });
  },

  onCapacity(e) {
    let v = parseInt(e.detail.value, 10);
    if (isNaN(v) || v < 1) v = '';
    this.setData({ capacity: v });
  },

  onPick(e) {
    const { field } = e.currentTarget.dataset;
    this.setData({ [field]: e.detail.value });
  },

  async submit() {
    const d = this.data;
    if (!d.title.trim()) return wx.showToast({ title: '请填写活动标题', icon: 'none' });
    if (!d.startDate || !d.startTime) return wx.showToast({ title: '请选择开始时间', icon: 'none' });
    if (!d.capacity || d.capacity < 1) return wx.showToast({ title: '名额需≥1', icon: 'none' });

    const start = new Date(d.startDate + 'T' + d.startTime + ':00');
    if (isNaN(start.getTime())) return wx.showToast({ title: '开始时间无效', icon: 'none' });

    let endTime = null;
    if (d.endDate && d.endTime) {
      const end = new Date(d.endDate + 'T' + d.endTime + ':00');
      if (!isNaN(end.getTime())) endTime = end.toISOString();
    }

    this.setData({ submitting: true });
    wx.showLoading({ title: '创建中' });
    try {
      await request('POST', '/api/activities', {
        title: d.title.trim(),
        location: d.location.trim(),
        description: d.description.trim(),
        startTime: start.toISOString(),
        endTime,
        capacity: Number(d.capacity),
      });
      wx.hideLoading();
      wx.showToast({ title: '创建成功', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 700);
    } catch (e) {
      wx.hideLoading();
      this.setData({ submitting: false });
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },
});
