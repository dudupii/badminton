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

module.exports = { pad, dateTime };
