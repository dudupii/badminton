App({
  globalData: {
    token: null,
    openid: null,
    userInfo: null,
  },
  onLaunch() {
    this.globalData.token = wx.getStorageSync('token') || null;
  },
});
