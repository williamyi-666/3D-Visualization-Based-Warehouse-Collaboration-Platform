import test from 'node:test';
import assert from 'node:assert/strict';
import {formatBusinessTime} from '../apps/web/prototype/business-time.mjs';

test('流水 UTC 与盘点 ISO 的同一时刻显示一致，保留时区', () => {
  const expected = formatBusinessTime('2026-09-19T06:03:23Z', 'Asia/Shanghai');
  assert.equal(formatBusinessTime('2026-09-19 06:03:23', 'Asia/Shanghai'), expected);
  assert.equal(formatBusinessTime('2026-09-19T14:03:23+08:00', 'Asia/Shanghai'), expected);
  assert.match(expected, /14:03:23/);
  assert.match(expected, /GMT\+8/);
  assert.match(formatBusinessTime('2026-09-19 06:03:23', 'UTC'), /06:03:23/);
});

test('缺失和未知格式不伪造时间', () => {
  assert.equal(formatBusinessTime(null), '时间未知');
  assert.equal(formatBusinessTime('未知时间'), '未知时间');
  assert.equal(formatBusinessTime('2026-09-19T06:03:23'), '2026-09-19T06:03:23');
  assert.equal(formatBusinessTime('invalidTZ'), 'invalidTZ');
});
