const { request } = require('../../utils/request');

function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

function dateStr(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function timeStr(d) {
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
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
    todayDate: '',
    submitting: false,
  },

  onLoad() {
    // Default to tomorrow so the activity is always future-dated and
    // registerable, even late at night.
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    this.setData({
      todayDate: dateStr(new Date()),
      startDate: dateStr(tomorrow),
      endDate: dateStr(tomorrow),
    });
  },

  async copyLast() {
    try {
      const list = await request('GET', '/api/activities/created-by/me');
      if (!list.length) {
        return wx.showToast({ title: '还没有历史活动可复制', icon: 'none' });
      }
      const last = list[0]; // newest
      const lastStart = new Date(last.startTime);
      // shift +7 days, keep same weekday & time
      const next = new Date(lastStart.getTime() + 7 * 24 * 60 * 60 * 1000);
      this.setData({
        title: last.title || '',
        location: last.location || '',
        description: last.description || '',
        capacity: last.capacity || 8,
        startDate: dateStr(next),
        startTime: timeStr(lastStart),
        endDate: dateStr(next),
      });
      wx.showToast({ title: '已复制，请核对时间', icon: 'none' });
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
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

  // Explicit per-field change handlers for the date/time pickers — avoids any
  // ambiguity from computed-key setData and keeps the tap target reliable.
  onStartDateChange(e) {
    this.setData({ startDate: e.detail.value });
  },
  onStartTimeChange(e) {
    this.setData({ startTime: e.detail.value });
  },
  onEndDateChange(e) {
    this.setData({ endDate: e.detail.value });
  },
  onEndTimeChange(e) {
    this.setData({ endTime: e.detail.value });
  },

  async submit() {
    const d = this.data;
    if (!d.title.trim()) return wx.showToast({ title: '请填写活动标题', icon: 'none' });
    if (!d.startDate || !d.startTime) return wx.showToast({ title: '请选择开始时间', icon: 'none' });
    if (!d.capacity || d.capacity < 1) return wx.showToast({ title: '名额需≥1', icon: 'none' });

    const start = new Date(d.startDate + 'T' + d.startTime + ':00');
    if (isNaN(start.getTime())) return wx.showToast({ title: '开始时间无效', icon: 'none' });
    if (start.getTime() < Date.now()) {
      return wx.showToast({ title: '开始时间已过，请选择未来时间', icon: 'none' });
    }

    let endTime = null;
    if (d.endDate && d.endTime) {
      const end = new Date(d.endDate + 'T' + d.endTime + ':00');
      if (!isNaN(end.getTime())) endTime = end.toISOString();
    }

    this.setData({ submitting: true });
    wx.showLoading({ title: '创建中' });
    try {
      const created = await request('POST', '/api/activities', {
        title: d.title.trim(),
        location: d.location.trim(),
        description: d.description.trim(),
        startTime: start.toISOString(),
        endTime,
        capacity: Number(d.capacity),
      });
      wx.hideLoading();
      wx.showToast({ title: '创建成功', icon: 'success' });
      // Jump to the detail page so the organizer can grab / share the QR.
      setTimeout(() => {
        wx.redirectTo({ url: '/pages/detail/detail?id=' + created.id });
      }, 800);
    } catch (e) {
      wx.hideLoading();
      this.setData({ submitting: false });
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },
});
