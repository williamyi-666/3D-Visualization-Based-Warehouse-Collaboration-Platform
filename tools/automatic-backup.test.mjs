import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backupBusinessState } from '../apps/api/backup.mjs';
import { restoreBackup } from './backup-data.mjs';

test('自动备份成套保留：历史库和附件一致，失败不淘汰，旧备份不删除', () => {
  const root = mkdtempSync(join(tmpdir(), 'spatial-auto-backup-'));
  let db;
  try {
    const data = join(root, 'data'), uploads = join(root, 'uploads');
    mkdirSync(data); mkdirSync(uploads);
    db = new DatabaseSync(join(data, 'spatial.db'));
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE sample(version INTEGER); INSERT INTO sample VALUES(1)');
    const save = version => {
      db.prepare('UPDATE sample SET version=?').run(version);
      writeFileSync(join(uploads, 'model.glb'), '模型' + version);
      return backupBusinessState(data, uploads, 2);
    };
    const first = save(1), second = save(2);
    const legacy = join(data, 'backup', 'spatial-old.db');
    writeFileSync(legacy, '旧备份');
    save(3);
    assert.equal(existsSync(first.bundle), false);
    assert.equal(existsSync(second.bundle), true);
    assert.equal(readFileSync(legacy, 'utf8'), '旧备份');
    restoreBackup(second.bundle, join(root, 'restored'), join(root, 'assets'));
    const restored = new DatabaseSync(join(root, 'restored', 'spatial.db'));
    try { assert.equal(restored.prepare('SELECT version FROM sample').get().version, 2); }
    finally { restored.close(); }
    assert.equal(readFileSync(join(root, 'assets', 'model.glb'), 'utf8'), '模型2');
    assert.throws(() => backupBusinessState(data, join(root, 'missing'), 1), /上传目录不存在/);
    assert.equal(existsSync(second.bundle), true);
    assert.equal(readdirSync(join(data, 'backup')).filter(x => x.startsWith('bundle-')).length, 2);
    assert.throws(() => backupBusinessState(data, uploads, NaN), /正整数/);
  } finally { db?.close(); rmSync(root, { recursive: true, force: true }); }
});
