function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

function dateTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return (
    d.getFullYear() +
    '-' +
    pad(d.getMonth() + 1) +
    '-' +
    pad(d.getDate()) +
    ' 周' +
    WEEK[d.getDay()] +
    ' ' +
    pad(d.getHours()) +
    ':' +
    pad(d.getMinutes())
  );
}

// Friendly relative time: "今天 19:00", "明天 19:00", "周三 19:00", "下周三", "已过期"
function friendlyTime(ms) {
  if (!ms) return '';
  const now = new Date();
  const d = new Date(ms);
  const hhmm = pad(d.getHours()) + ':' + pad(d.getMinutes());
  const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day0 = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((day0 - today0) / 86400000);
  const weekday = '周' + WEEK[d.getDay()];

  if (diffDays < 0) return '已过期';
  if (diffDays === 0) return '今天 ' + hhmm;
  if (diffDays === 1) return '明天 ' + hhmm;
  if (diffDays === 2) return '后天 ' + hhmm;
  if (diffDays <= 6) return weekday + ' ' + hhmm;
  if (diffDays <= 13) return '下' + weekday + ' ' + hhmm;
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hhmm;
}

module.exports = { pad, dateTime, friendlyTime };
