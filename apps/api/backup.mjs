import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { makeBackup, verifyBackup } from '../../tools/backup-data.mjs';
let lastStamp = 0;

// 同步执行，避免本进程请求在数据库快照和附件复制之间交错写入。
// 多进程或外部工具也会写资产时，应使用停机备份工具。
export function backupBusinessState(data, uploads, keep = 28) {
  if (!Number.isInteger(keep) || keep < 1) throw new Error('BACKUP_KEEP 必须为正整数');
  const root = join(data, 'backup');
  mkdirSync(root, { recursive: true });
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  const name = 'bundle-' + new Date(lastStamp).toISOString().replaceAll(':', '-') + '-' + randomUUID();
  const pending = join(root, '.' + name);
  const target = join(root, name);
  makeBackup(data, uploads, pending);
  verifyBackup(pending);
  renameSync(pending, target); // 只有整套成功后才纳入保留与恢复候选。
  const bundles = readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory() && /^bundle-\d{4}-\d{2}-\d{2}T[\d.-]+Z-[0-9a-f-]{36}$/.test(e.name))
    .map(e => e.name).sort().reverse();
  for (const name of bundles.slice(keep)) {
    const path = join(root, name);
    verifyBackup(path); // 不自动清理损坏或不完整的备份，也不触碰旧格式文件。
    rmSync(path, { recursive: true });
  }
  return { ok: true, bundle: target, db: join(target, 'spatial.db'),
    size: statSync(join(target, 'spatial.db')).size, uploads: true };
}
