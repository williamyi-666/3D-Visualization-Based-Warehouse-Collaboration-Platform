// SQLite datetime('now') 返回无时区的 UTC；盘点时间使用带时区的 ISO。
// 两者统一为浏览器本地时间，并显示时区，存储值保持不变。
export function formatBusinessTime(value, timeZone) {
  if (!value) return '时间未知';
  const raw = String(value).trim();
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)
    ? raw.replace(' ', 'T') + 'Z' : raw;
  if (!/T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized)) return raw;
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime())) return raw;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', timeZoneName: 'short', ...(timeZone ? {timeZone} : {})
  }).format(date);
}
