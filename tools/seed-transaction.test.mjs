import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('首次仓库初始化失败整体回滚，重试完整且重启不重复生成', () => {
  const dir = mkdtempSync(join(tmpdir(), 'warehouse-seed-'));
  const db = new DatabaseSync(join(dir, 'spatial.db'));
  try {
    // 在初始化第二座货架时制造失败，检查此前写入的格位、货品和流水是否全部撤销。
    db.exec(`CREATE TABLE space_node (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, parent_id TEXT,
      loc_code TEXT UNIQUE, node_type TEXT NOT NULL, name TEXT NOT NULL,
      geom TEXT DEFAULT '{}', template TEXT DEFAULT '{}', attributes TEXT DEFAULT '{}'
    );
    CREATE TRIGGER fail_seed BEFORE INSERT ON space_node
    WHEN NEW.loc_code='WH-1-B' BEGIN SELECT RAISE(ABORT, 'seed rollback probe'); END;`);
    const boot = () => spawnSync(process.execPath, ['--input-type=module', '-e', "import './apps/api/db.mjs'"], {
      env: { ...process.env, SPATIAL_DATA_DIR: dir }, encoding: 'utf8', timeout: 60000,
    });
    const failed = boot();
    assert.equal(failed.status, 1, failed.stderr);
    assert.match(failed.stderr, /seed rollback probe/);
    for (const table of ['tenant', 'space_node', 'item', 'inventory', 'movement']) {
      assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0, table);
    }
    db.exec('DROP TRIGGER fail_seed');
    const success = boot();
    assert.equal(success.status, 0, success.stderr);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM space_node WHERE node_type='cell'").get().n, 90);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM inventory').get().n, 9);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM movement').get().n, 9);
    const before = db.prepare('SELECT id, qty FROM inventory ORDER BY id').all();
    const restarted = boot();
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.deepEqual(db.prepare('SELECT id, qty FROM inventory ORDER BY id').all(), before);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
