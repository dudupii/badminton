const { request } = require('../../utils/request');
const { ensureLogin } = require('../../utils/auth');
const { BASE_URL, SUBSCRIBE_TEMPLATES } = require('../../utils/config');
const fmt = require('../../utils/format');

Page({
  data: {
    id: '',
    scene: '', // invite code, present when opened by scanning the activity QR
    detail: null,
    qrcodeUrl: '',
    loading: true,
    proxyName: '', // 代理追加昵称输入
    isCreator: false,
    canRegister: false,
    canCancel: false,
    isPast: false,
    myWaitPos: 0,
    genderCount: { male: 0, female: 0 },
    fee: null,
    feeSummary: null,
    feeEdit: { mode: 'total', amount: '', splitBy: 'confirmed' },
    myFee: null,
    groupMode: 'rotation',
    rotCourts: 3,
    rotRounds: 6,
    rotLevelMode: 'homogeneous',
    rotFixed: [], // [[openid,openid],…]
    rotFixedFlat: [], // openids that are in some fixed pair (for wxml highlight)
    rotPairPick: null, // openid of first half-picked pair, or null
    rotMatchFormat: 'any', // any|mens|womens|mixed
    rotCurrentRound: 0,
    sessCourts: 3,
    sessLevelMode: 'homogeneous',
    sessMatchFormat: 'any',
    sessPresent: {},
    sessStarted: false,
    sessFairness: '',
  },

  onLoad(q) {
    // q.id: normal in-app navigation; q.scene: arrived via scanned mini-program code.
    const scene = q.scene ? decodeURIComponent(q.scene) : '';
    this.setData({ id: q.id || '', scene });
  },

  async onShow() {
    try {
      await ensureLogin();
    } catch (e) {
      wx.showToast({ title: '登录失败：' + e.message, icon: 'none' });
    }
    await this.load();
  },

  async load() {
    try {
      this.setData({ loading: true });
      const d = await request(
        'GET',
        this.data.scene
          ? '/api/activities/by-code/' + encodeURIComponent(this.data.scene)
          : '/api/activities/' + this.data.id
      );
      const app = getApp();
      const me = app.globalData.openid;

      d.timeText = fmt.dateTime(d.startTime);
      d.endText = d.endTime ? fmt.dateTime(d.endTime) : '';

      // avatars are stored server-relative; resolve for <image> display
      const resolveAvatar = (x) => {
        if (x && x.avatarUrl && x.avatarUrl.startsWith('/')) x.avatarUrl = BASE_URL + x.avatarUrl;
      };
      (d.confirmed || []).forEach(resolveAvatar);
      (d.waitlist || []).forEach(resolveAvatar);

      const now = Date.now();
      const isPast = !!(d.startTime && d.startTime < now);
      const myStatus = d.myStatus;
      const myWaitPos =
        myStatus === 'waitlist'
          ? d.waitlist.findIndex((x) => x.openid === me) + 1
          : 0;

      // Hydrate the fee-edit form from the stored fee so reopening an activity
      // with a fee shows it (and clearing the fee resets the input to blank).
      const feeEdit = d.fee
        ? {
            mode: d.fee.perPersonCents != null ? 'fixed' : 'total',
            amount:
              d.fee.perPersonCents != null
                ? String(d.fee.perPersonCents / 100)
                : d.fee.totalCents != null
                ? String(d.fee.totalCents / 100)
                : '',
            splitBy: d.fee.splitBy || 'confirmed',
          }
        : { mode: 'total', amount: '', splitBy: 'confirmed' };

      if (d.rotation) d.rotation = this._injectRotationNo(d.rotation, d.confirmed);

      this.setData({
        feeEdit,
        id: d.id,
        detail: d,
        qrcodeUrl: BASE_URL + '/api/activities/' + d.id + '/qrcode',
        qrcodeLocal: '', // local temp path for <image> (real phone blocks HTTP images)
        loading: false,
        isCreator: me === d.createdBy,
        isPast,
        myWaitPos,
        canRegister: !myStatus && d.status === 'open' && !isPast,
        canCancel: !!myStatus,
        genderCount: {
          male: d.confirmed.filter((x) => x.gender === '男').length,
          female: d.confirmed.filter((x) => x.gender === '女').length,
        },
        fee: d.fee,
        feeSummary: d.feeSummary,
        myFee: (d.confirmed || []).find((x) => x.openid === me) || null,
        rules: d.rules,
        sessStarted: !!(d.session && d.session.currentRound > 0),
        rotCurrentRound: d.rotation ? (d.rotation.currentRound || 0) : 0,
      });

      // Download QR to local temp file — real phone blocks <image src="http://...">
      // even with "不校验合法域名" enabled. Local temp path renders everywhere.
      const qrUrl = BASE_URL + '/api/activities/' + d.id + '/qrcode';
      wx.downloadFile({
        url: qrUrl,
        success: (res) => {
          if (res.statusCode === 200) this.setData({ qrcodeLocal: res.tempFilePath });
        },
        fail: () => { /* fall back to qrcodeUrl */ },
      });
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  async doRegister() {
    // Real (non-placeholder) templates the user may authorize in one prompt.
    const tpls = ['promote', 'registered', 'remind']
      .map((k) => SUBSCRIBE_TEMPLATES[k])
      .filter((t) => t && !t.endsWith('_TPL_ID'));
    let accepted = null;
    if (tpls.length) {
      try {
        accepted = await new Promise((res) =>
          wx.requestSubscribeMessage({ tmplIds: tpls, success: res, fail: () => res(null) })
        );
      } catch (e) {
        accepted = null;
      }
    }
    const give = (tpl) =>
      accepted && accepted[tpl] === 'accept'
        ? request('POST', '/api/subscriptions', { templateId: tpl }).catch(() => {})
        : Promise.resolve();
    try {
      // Grant the "registered" credit BEFORE register so the route can consume
      // it and send the success message in the same request.
      if (accepted && accepted[SUBSCRIBE_TEMPLATES.registered] === 'accept') {
        await give(SUBSCRIBE_TEMPLATES.registered);
      }
      const r = await request('POST', '/api/activities/' + this.data.id + '/register');
      // Future-event credits (promotion / reminder) are granted after success.
      if (accepted && accepted[SUBSCRIBE_TEMPLATES.promote] === 'accept') {
        await give(SUBSCRIBE_TEMPLATES.promote);
      }
      if (accepted && accepted[SUBSCRIBE_TEMPLATES.remind] === 'accept') {
        await give(SUBSCRIBE_TEMPLATES.remind);
      }
      wx.showToast({ title: r.message, icon: 'none', duration: 2000 });
      this.load();
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  async doCancel() {
    const confirm = await new Promise((resolve) => {
      wx.showModal({
        title: '取消报名',
        content: '确定取消吗？如果是正式名额，候补第一名将自动上位。',
        confirmColor: '#dc2626',
        success: (m) => resolve(m.confirm),
      });
    });
    if (!confirm) return;

    try {
      const r = await request('POST', '/api/activities/' + this.data.id + '/cancel');
      let msg = '已取消报名';
      if (r.promoted) {
        msg = '已取消，候补的「' + (r.promoted.nickname || '球友') + '」已自动上位';
      }
      wx.showToast({ title: msg, icon: 'none', duration: 2500 });
      this.load();
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  async toggleStatus() {
    const d = this.data.detail;
    const next = d.status === 'open' ? 'closed' : 'open';
    try {
      await request('PATCH', '/api/activities/' + this.data.id, { status: next });
      this.load();
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  goEdit() {
    wx.navigateTo({ url: '/pages/create/create?id=' + this.data.id });
  },

  onFeeModeChange(e) {
    this.setData({ 'feeEdit.mode': Number(e.detail.value) === 1 ? 'fixed' : 'total' });
  },
  onFeeSplitChange(e) {
    this.setData({ 'feeEdit.splitBy': Number(e.detail.value) === 1 ? 'attended' : 'confirmed' });
  },
  onFeeAmount(e) {
    this.setData({ 'feeEdit.amount': e.detail.value });
  },
  async saveFee() {
    const d = this.data;
    const yuan = parseFloat(d.feeEdit.amount);
    const cents = isNaN(yuan) ? 0 : Math.round(yuan * 100);
    let body;
    if (!cents) {
      body = {}; // empty body clears the fee
    } else if (d.feeEdit.mode === 'total') {
      body = { totalCents: cents, splitBy: d.feeEdit.splitBy };
    } else {
      body = { perPersonCents: cents, splitBy: d.feeEdit.splitBy };
    }
    try {
      await request('PUT', '/api/activities/' + d.id + '/fee', body);
      this.load();
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },
  async togglePaid(e) {
    const { openid, paid } = e.currentTarget.dataset;
    try {
      await request('POST', '/api/activities/' + this.data.id + '/roster/' + openid + '/paid', { paid: !paid });
      this.load();
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },
  async toggleAttend(e) {
    const { openid, attended } = e.currentTarget.dataset;
    // 3-state cycle: 到(true) → 缺(false) → 未签/clear(null) → 到…
    // (post-start, unmarked shows as 到 by default, so tapping marks 缺)
    const next = attended === true ? false : attended === false ? null : true;
    try {
      await request('POST', '/api/activities/' + this.data.id + '/roster/' + openid + '/attend', { attended: next });
      this.load();
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },
  exportFee() {
    // Copy a CSV ledger to clipboard (the simulator/WeChat can't download a
    // token-gated URL, so we build it client-side from data we already have).
    const d = this.data.detail;
    if (!d || !d.confirmed || !d.confirmed.length) {
      return wx.showToast({ title: '暂无可导出的名单', icon: 'none' });
    }
    const rows = ['昵称,应付(元),已付,签到'];
    for (const e of d.confirmed) {
      const name = '"' + String(e.nickname || '').replace(/"/g, '""') + '"';
      const owed = (e.owedCents / 100).toFixed(2);
      const paid = e.paid ? '是' : '否';
      const att = e.attended === true ? '到' : e.attended === false ? '缺' : '未签';
      rows.push([name, owed, paid, att].join(','));
    }
    wx.setClipboardData({
      data: rows.join('\n'),
      success: () => wx.showToast({ title: '费用表已复制到剪贴板', icon: 'none' }),
    });
  },

  onGroupModeChange(e) {
    this.setData({ groupMode: Number(e.detail.value) === 1 ? 'session' : 'rotation' });
  },
  // 给轮转 schedule 的每个 player 注入报名序号 no（confirmed 里第几个=几号）。
  _injectRotationNo(rotation, confirmed) {
    if (!rotation || !rotation.schedule) return rotation;
    const noMap = {};
    (confirmed || []).forEach((x, i) => { noMap[x.openid] = i + 1; });
    rotation.schedule = rotation.schedule.map((rd) =>
      rd.map((c) => c.map((p) => ({ ...p, no: noMap[p.openid] || '?' })))
    );
    return rotation;
  },

  async genRotation() {
    const d = this.data;
    try {
      const r = await request('POST', '/api/activities/' + d.id + '/rotation', {
        courts: d.rotCourts,
        rounds: d.rotRounds,
        levelMode: d.rotLevelMode,
        matchFormat: d.rotMatchFormat,
        fixedPairs: d.rotFixed,
      });
      // r is the activity object (with rotation); pull rotation into detail
      this.setData({ detail: { ...d.detail, rotation: this._injectRotationNo(r.rotation, d.detail.confirmed) } });
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },
  async clearRotation() {
    try {
      await request('DELETE', '/api/activities/' + this.data.id + '/rotation');
      this.setData({ detail: { ...this.data.detail, rotation: null } });
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },
  onProxyName(e) { this.setData({ proxyName: e.detail.value }); },
  async proxyRegister() {
    const d = this.data;
    const name = (d.proxyName || '').trim();
    if (!name) return wx.showToast({ title: '请填写昵称', icon: 'none' });
    try {
      const r = await request('POST', '/api/activities/' + d.id + '/register-proxy', { nickname: name });
      wx.showToast({ title: r.message, icon: 'none' });
      this.setData({ proxyName: '' });
      this.load();
    } catch (e) { wx.showToast({ title: e.message, icon: 'none' }); }
  },
  async forceRemove(e) {
    const { openid, name } = e.currentTarget.dataset;
    const confirm = await new Promise((res) => {
      wx.showModal({ title: '移除报名', content: '确定移除「' + (name || '') + '」吗？', confirmColor: '#dc2626', success: (m) => res(m.confirm) });
    });
    if (!confirm) return;
    try {
      const r = await request('DELETE', '/api/activities/' + this.data.id + '/roster/' + openid);
      let msg = '已移除';
      if (r.promoted) msg += '，候补「' + (r.promoted.nickname || '球友') + '」已上位';
      wx.showToast({ title: msg, icon: 'none', duration: 2500 });
      this.load();
    } catch (e) { wx.showToast({ title: e.message, icon: 'none' }); }
  },
  // 复制报名名单(正式+候补)为纯文本到剪贴板——只有号码+名字，不含性别/水平。
  exportRoster() {
    const d = this.data.detail;
    if (!d || !d.confirmed || !d.confirmed.length) {
      return wx.showToast({ title: '暂无名单', icon: 'none' });
    }
    const lines = [(d.title || '活动') + ' · 报名名单'];
    lines.push('正式名单 (' + d.confirmed.length + '/' + d.capacity + ')');
    d.confirmed.forEach((p, i) => lines.push((i + 1) + '-' + (p.nickname || '')));
    if (d.waitlist && d.waitlist.length) {
      lines.push('候补 (' + d.waitlist.length + ')');
      d.waitlist.forEach((p, i) => lines.push((i + 1) + '-' + (p.nickname || '')));
    }
    wx.setClipboardData({
      data: lines.join('\n'),
      success: () => wx.showToast({ title: '名单已复制到剪贴板', icon: 'none' }),
    });
  },
  // 复制轮转表为纯文本到剪贴板——号码+名字，可粘贴到微信群。
  exportRotation() {
    const detail = this.data.detail;
    const rot = detail && detail.rotation;
    if (!rot || !rot.schedule) return wx.showToast({ title: '请先生成轮转', icon: 'none' });
    const rosterMap = {};
    (detail.confirmed || []).forEach((x, i) => { rosterMap[x.openid] = { no: i + 1, nickname: x.nickname || '' }; });
    const label = (p) => {
      const oid = typeof p === 'string' ? p : p.openid;
      const r = rosterMap[oid] || {};
      return (typeof p === 'object' ? (p.no || r.no || '?') : (r.no || '?')) + '-' +
        (typeof p === 'object' && p.nickname != null ? p.nickname : (r.nickname || ''));
    };
    const lines = [(detail.title || '活动') + ' · 轮转表'];
    rot.schedule.forEach((rd, ri) => {
      lines.push('第' + (ri + 1) + '轮');
      rd.forEach((c, ci) => lines.push('  场' + (ci + 1) + ': ' + c.map(label).join(' / ')));
      lines.push('  休息: ' + (rot.resting[ri] || []).map(label).join('、'));
    });
    wx.setClipboardData({
      data: lines.join('\n'),
      success: () => wx.showToast({ title: '轮转表已复制到剪贴板', icon: 'none' }),
    });
  },
  async setRotCurrentRound(r) {
    const d = this.data;
    try {
      const res = await request('POST', '/api/activities/' + d.id + '/rotation/current', { round: r });
      this.setData({ detail: { ...d.detail, rotation: this._injectRotationNo(res.rotation, d.detail.confirmed) }, rotCurrentRound: r });
    } catch (e) { wx.showToast({ title: e.message, icon: 'none' }); }
  },
  rotPrev() { const r = Math.max(0, this.data.rotCurrentRound - 1); this.setRotCurrentRound(r); },
  rotNext() { const max = ((this.data.detail.rotation && this.data.detail.rotation.schedule && this.data.detail.rotation.schedule.length) || 1) - 1; const r = Math.min(max, this.data.rotCurrentRound + 1); this.setRotCurrentRound(r); },
  copyOneRound(e) {
    const ri = e.currentTarget.dataset.ri;
    const rot = this.data.detail.rotation;
    if (!rot || !rot.schedule[ri]) return;
    const noMap = {}; (this.data.detail.confirmed || []).forEach((x, i) => { noMap[x.openid] = i + 1; });
    const label = (p) => (p.no || noMap[p.openid] || '?') + '-' + (p.nickname || '');
    const rd = rot.schedule[ri];
    const lines = ['第' + (ri + 1) + '轮' + (ri === this.data.rotCurrentRound ? ' ▶当前' : '')];
    rd.forEach((c, ci) => lines.push('场' + (ci + 1) + ': ' + c.map(label).join(' / ')));
    const restLabel = (oid) => (noMap[oid] || '?') + '-' + (((this.data.detail.confirmed || []).find((x) => x.openid === oid)) || {}).nickname || oid;
    lines.push('休息: ' + (rot.resting[ri] || []).map(restLabel).join('、'));
    wx.setClipboardData({ data: lines.join('\n'), success: () => wx.showToast({ title: '第' + (ri + 1) + '轮已复制', icon: 'none' }) });
  },
  async startSession() {
    const d = this.data;
    try {
      const r = await request('POST', '/api/activities/' + d.id + '/session/start', {
        courts: d.sessCourts, levelMode: d.sessLevelMode, matchFormat: d.sessMatchFormat,
      });
      const present = {};
      (d.detail.confirmed || []).forEach((p) => { present[p.openid] = true; });
      this.setData({ detail: { ...d.detail, session: r.session }, sessPresent: present, sessStarted: true });
    } catch (e) { wx.showToast({ title: e.message, icon: 'none' }); }
  },
  toggleSessPresent(e) {
    const oid = e.currentTarget.dataset.openid;
    const p = Object.assign({}, this.data.sessPresent);
    p[oid] = !p[oid];
    this.setData({ sessPresent: p });
  },
  async assignSession() {
    const d = this.data;
    const present = Object.keys(d.sessPresent).filter((k) => d.sessPresent[k]);
    try {
      const r = await request('POST', '/api/activities/' + d.id + '/session/assign', { present });
      this.setData({ detail: { ...d.detail, session: r.session } });
      this.setData({ sessFairness: this._fairnessText(r.session) });
    } catch (e) { wx.showToast({ title: e.message, icon: 'none' }); }
  },
  async undoSession() {
    try {
      const r = await request('POST', '/api/activities/' + this.data.id + '/session/undo');
      this.setData({ detail: { ...this.data.detail, session: r.session }, sessFairness: this._fairnessText(r.session) });
    } catch (e) { wx.showToast({ title: e.message, icon: 'none' }); }
  },
  async changeSessionCourts() {
    const d = this.data;
    try {
      const r = await request('POST', '/api/activities/' + d.id + '/session/courts', { courts: d.sessCourts });
      this.setData({ detail: { ...d.detail, session: r.session } });
      wx.showToast({ title: '场地数已更新', icon: 'none' });
    } catch (e) { wx.showToast({ title: e.message, icon: 'none' }); }
  },
  _fairnessText(session) {
    if (!session || !session.games) return '';
    const roster = (this.data.detail.confirmed || []);
    return roster
      .map((p) => ({ no: p.no, nickname: p.nickname, g: session.games[p.openid] || 0 }))
      .sort((a, b) => b.g - a.g)
      .map((p) => p.no + '-' + p.nickname + ':' + p.g)
      .join(' · ');
  },
  async clearSession() {
    try {
      await request('DELETE', '/api/activities/' + this.data.id + '/session');
      this.setData({ detail: { ...this.data.detail, session: null }, sessStarted: false });
    } catch (e) { wx.showToast({ title: e.message, icon: 'none' }); }
  },
  onSessCourts(e) { this.setData({ sessCourts: e.detail.value }); },
  onSessCourtsBlur(e) { let v = parseInt(e.detail.value, 10); this.setData({ sessCourts: isNaN(v) || v < 1 ? 1 : v }); },
  onSessLevelMode(e) { this.setData({ sessLevelMode: Number(e.detail.value) === 1 ? 'balanced' : 'homogeneous' }); },
  onSessMatchFormat(e) { this.setData({ sessMatchFormat: ['any','mens','womens','mixed'][Number(e.detail.value)] || 'any' }); },
  copySession() {
    const d = this.data.detail;
    const sess = d && d.session;
    if (!sess || !sess.rounds.length) return wx.showToast({ title: '暂无轮次', icon: 'none' });
    const noMap = {}; (d.confirmed || []).forEach((x, i) => { noMap[x.openid] = i + 1; });
    const label = (p) => (p.no || noMap[p.openid] || '?') + '-' + (p.nickname || '');
    const lines = [(d.title || '活动') + ' · 逐轮排场'];
    sess.rounds.forEach((rd, ri) => {
      lines.push('第' + (ri + 1) + '轮');
      rd.courts.forEach((c, ci) => lines.push('  场' + (ci + 1) + ': ' + c.map(label).join(' / ')));
      lines.push('  休息: ' + (rd.resting || []).map((oid) => (noMap[oid] || '?') + '-' + (((d.confirmed || []).find((x) => x.openid === oid)) || {}).nickname || oid).join('、'));
    });
    wx.setClipboardData({ data: lines.join('\n'), success: () => wx.showToast({ title: '已复制到剪贴板', icon: 'none' }) });
  },
  onRotCourts(e) { this.setData({ rotCourts: e.detail.value }); },
  onRotCourtsBlur(e) { let v = parseInt(e.detail.value, 10); this.setData({ rotCourts: isNaN(v) || v < 1 ? 1 : v }); },
  onRotRounds(e) { this.setData({ rotRounds: e.detail.value }); },
  onRotRoundsBlur(e) { let v = parseInt(e.detail.value, 10); this.setData({ rotRounds: isNaN(v) || v < 1 ? 1 : v }); },
  onRotLevelMode(e) { this.setData({ rotLevelMode: Number(e.detail.value) === 1 ? 'balanced' : 'homogeneous' }); },
  onRotMatchFormat(e) {
    this.setData({ rotMatchFormat: ['any', 'mens', 'womens', 'mixed'][Number(e.detail.value)] || 'any' });
  },
  // Tap to form pairs: tap 1st → tap 2nd → pair; tap an already-paired player → remove that pair
  toggleRotPair(e) {
    const oid = e.currentTarget.dataset.openid;
    const fixed = this.data.rotFixed.slice();
    const existing = fixed.findIndex((pr) => pr[0] === oid || pr[1] === oid);
    if (existing >= 0) {
      fixed.splice(existing, 1);
      this.setData({ rotFixed: fixed, rotFixedFlat: fixed.flat(), rotPairPick: null });
      return;
    }
    const pick = this.data.rotPairPick;
    if (!pick) { this.setData({ rotPairPick: oid }); return; }
    if (pick === oid) { this.setData({ rotPairPick: null }); return; }
    fixed.push([pick, oid]);
    this.setData({ rotFixed: fixed, rotFixedFlat: fixed.flat(), rotPairPick: null });
  },

  async deleteActivity() {
    const confirm = await new Promise((resolve) => {
      wx.showModal({
        title: '删除活动',
        content: '将删除该活动及其所有报名记录，且不可撤销。确定？',
        confirmText: '删除',
        confirmColor: '#dc2626',
        success: (m) => resolve(m.confirm),
      });
    });
    if (!confirm) return;
    try {
      await request('DELETE', '/api/activities/' + this.data.id);
      wx.showToast({ title: '已删除', icon: 'success' });
      setTimeout(() => wx.switchTab({ url: '/pages/index/index' }), 600);
    } catch (e) {
      wx.showToast({ title: e.message, icon: 'none' });
    }
  },

  copyLocation() {
    if (this.data.detail && this.data.detail.location) {
      wx.setClipboardData({ data: this.data.detail.location });
    }
  },

  // Forward the activity to a WeChat chat — recipient taps the card to open
  // this page and sign up. Works in dev/trial (testers) without a QR.
  onShareAppMessage() {
    const d = this.data.detail;
    return {
      title: d ? `邀请你参加：${d.title}` : '羽毛球活动报名',
      path: 'pages/detail/detail?id=' + this.data.id,
    };
  },

  async saveQrToAlbum() {
    if (!this.data.qrcodeUrl) return;
    try {
      const dl = await new Promise((res, rej) =>
        wx.downloadFile({ url: this.data.qrcodeUrl, success: res, fail: rej })
      );
      await new Promise((res, rej) => {
        wx.saveImageToPhotosAlbum({
          filePath: dl.tempFilePath,
          success: res,
          fail: (err) => {
            if (err.errMsg && err.errMsg.indexOf('auth deny') !== -1) {
              wx.showModal({
                title: '需要相册权限',
                content: '请在设置中开启"保存到相册"权限',
                confirmText: '去设置',
                success: (m) => {
                  if (m.confirm) wx.openSetting();
                },
              });
            }
            rej(err);
          },
        });
      });
      wx.showToast({ title: '已保存到相册', icon: 'success' });
    } catch (e) {
      wx.showToast({ title: '保存失败', icon: 'none' });
    }
  },

  async generatePoster() {
    const d = this.data.detail;
    if (!d) return;
    wx.showLoading({ title: '生成中' });
    try {
      // 1. 拉二维码图
      const dl = await new Promise((res, rej) =>
        wx.downloadFile({ url: this.data.qrcodeUrl, success: res, fail: rej })
      );
      // 2. 取 canvas 节点
      const { canvas, ctx, W, H } = await new Promise((res, rej) => {
        wx.createSelectorQuery()
          .select('#poster')
          .fields({ node: true, size: true })
          .exec((r) => (r && r[0] && r[0].node ? res(r[0]) : rej(new Error('canvas 不存在'))));
      }).then((info) => {
        const c = info.node;
        const ctx = c.getContext('2d');
        const dpr = wx.getSystemInfoSync().pixelRatio;
        c.width = info.width * dpr;
        c.height = info.height * dpr;
        ctx.scale(dpr, dpr);
        return { canvas: c, ctx, W: info.width, H: info.height };
      });

      // 3. 运动主题背景：绿渐变 + 🏸 水印
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#16a34a');
      g.addColorStop(1, '#065f46');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.font = '120px sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillText('🏸', W - 150, 170);

      // 4. 文案
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 30px sans-serif';
      this._wrapText(ctx, d.title || '羽毛球活动', 36, 90, W - 72, 38);
      ctx.font = '22px sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      let y = 220;
      ctx.fillText('⏰ ' + d.timeText, 36, y);
      y += 36;
      if (d.location) {
        ctx.fillText('📍 ' + d.location, 36, y);
        y += 36;
      }
      ctx.fillText('名额 ' + d.confirmedCount + '/' + d.capacity, 36, y);

      // 5. 二维码（加载图片后绘制并导出）
      const img = canvas.createImage();
      img.onload = () => {
        ctx.drawImage(img, W - 200, H - 230, 164, 164);
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.font = '18px sans-serif';
        ctx.fillText('扫码报名', W - 180, H - 44);
        wx.canvasToTempFilePath({
          canvas,
          success: (out) => {
            wx.hideLoading();
            wx.previewImage({ urls: [out.tempFilePath] }); // 长按可保存/分享
          },
          fail: () => {
            wx.hideLoading();
            wx.showToast({ title: '生成失败', icon: 'none' });
          },
        });
      };
      img.onerror = () => {
        wx.hideLoading();
        wx.showToast({ title: '二维码加载失败', icon: 'none' });
      };
      img.src = dl.tempFilePath;
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: e.message || '生成失败', icon: 'none' });
    }
  },

  _wrapText(ctx, text, x, y, maxWidth, lineHeight) {
    // 简易中文换行（按字符）
    let line = '';
    for (const ch of String(text)) {
      const test = line + ch;
      if (ctx.measureText(test).width > maxWidth && line) {
        ctx.fillText(line, x, y);
        line = ch;
        y += lineHeight;
      } else {
        line = test;
      }
    }
    if (line) ctx.fillText(line, x, y);
  },
});
