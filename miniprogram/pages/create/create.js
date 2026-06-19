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
    editId: '', // when set, the form edits this activity instead of creating
    repeatMode: 0, // 0=不重复 1=每天 2=每周 3=自定义
    repeatOptions: ['不重复', '每天', '每周', '自定义'],
    repeatCount: 4, // how many sessions when repeating
    customStep: 7, // days between sessions when 自定义
  },

  onLoad(q) {
    // Default to tomorrow so a new activity is always future-dated and
    // registerable, even late at night.
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    this.setData({
      todayDate: dateStr(new Date()),
      startDate: dateStr(tomorrow),
      endDate: dateStr(tomorrow),
      editId: (q && q.id) || '',
    });
    if (q && q.id) this.loadForEdit(q.id);
  },

  // Prefill the form from an existing activity (edit mode).
  async loadForEdit(id) {
    try {
      const a = await request('GET', '/api/activities/' + id);
      const start = new Date(a.startTime);
      const patch = {
        title: a.title || '',
        location: a.location || '',
        description: a.description || '',
        capacity: a.capacity,
        startDate: dateStr(start),
        startTime: timeStr(start),
      };
      if (a.endTime) {
        const end = new Date(a.endTime);
        patch.endDate = dateStr(end);
        patch.endTime = timeStr(end);
      }
      this.setData(patch);
    } catch (e) {
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
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

  onRepeatChange(e) {
    this.setData({ repeatMode: Number(e.detail.value) });
  },
  onRepeatCountChange(e) {
    let v = parseInt(e.detail.value, 10);
    if (isNaN(v) || v < 1) v = 1;
    if (v > 12) v = 12;
    this.setData({ repeatCount: v });
  },
  onCustomStepChange(e) {
    let v = parseInt(e.detail.value, 10);
    if (isNaN(v) || v < 1) v = 1;
    this.setData({ customStep: v });
  },

  // Translate the repeat picker into a {count, stepDays} payload (or null).
  buildRepeat() {
    const d = this.data;
    const mode = d.repeatMode;
    if (mode === 0) return null;
    const stepDays = mode === 1 ? 1 : mode === 2 ? 7 : Math.max(1, d.customStep || 7);
    return { count: Math.max(1, d.repeatCount || 1), stepDays };
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
    // New activities must be future-dated; edits allow correcting a past time.
    if (!d.editId && start.getTime() < Date.now()) {
      return wx.showToast({ title: '开始时间已过，请选择未来时间', icon: 'none' });
    }

    let endTime = null;
    if (d.endDate && d.endTime) {
      const end = new Date(d.endDate + 'T' + d.endTime + ':00');
      if (!isNaN(end.getTime())) endTime = end.toISOString();
    }

    const payload = {
      title: d.title.trim(),
      location: d.location.trim(),
      description: d.description.trim(),
      startTime: start.toISOString(),
      endTime,
      capacity: Number(d.capacity),
    };
    const repeat = d.editId ? null : this.buildRepeat();
    if (repeat) payload.repeat = repeat;

    this.setData({ submitting: true });
    wx.showLoading({ title: d.editId ? '保存中' : '创建中' });
    try {
      if (d.editId) {
        await request('PUT', '/api/activities/' + d.editId, payload);
        wx.hideLoading();
        wx.showToast({ title: '已保存', icon: 'success' });
        setTimeout(() => wx.navigateBack(), 600);
      } else {
        const res = await request('POST', '/api/activities', payload);
        wx.hideLoading();
        if (res && res.activities) {
          wx.showToast({ title: '已创建 ' + res.activities.length + ' 场', icon: 'success' });
          setTimeout(() => wx.switchTab({ url: '/pages/index/index' }), 800);
        } else {
          wx.showToast({ title: '创建成功', icon: 'success' });
          // Jump to the detail page so the organizer can grab / share the QR.
          setTimeout(() => {
            wx.redirectTo({ url: '/pages/detail/detail?id=' + res.id });
          }, 800);
        }
      }
    } catch (e) {
      wx.hideLoading();
      this.setData({ submitting: false });
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },
});
