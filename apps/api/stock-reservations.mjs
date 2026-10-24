export function installStockReservations(sql){
  sql.exec(`CREATE TABLE IF NOT EXISTS stock_reservation (
    line_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,tenant_id TEXT NOT NULL,
    node_id TEXT NOT NULL,item_id TEXT NOT NULL,qty REAL NOT NULL CHECK(qty>0));
    CREATE INDEX IF NOT EXISTS reservation_stock ON stock_reservation(node_id,item_id);
    CREATE INDEX IF NOT EXISTS reservation_task ON stock_reservation(task_id);`);
  // 所有库存写入口共用约束。任务执行须在同一事务中先释放本次数量，再正常出/移库。
  for(const [name,action] of [['insert','INSERT'],['update','UPDATE']])sql.exec(`
    CREATE TRIGGER IF NOT EXISTS reservation_capacity_${name} BEFORE ${action} ON stock_reservation
    BEGIN SELECT CASE WHEN NEW.qty+COALESCE((SELECT SUM(qty) FROM stock_reservation
      WHERE node_id=NEW.node_id AND item_id=NEW.item_id AND line_id!=NEW.line_id),0)
      >COALESCE((SELECT qty FROM inventory WHERE node_id=NEW.node_id AND item_id=NEW.item_id),0)
      THEN RAISE(ABORT,'可用库存不足，已有任务预占，请核对任务或减少数量') END; END;`);
  sql.exec(`CREATE TRIGGER IF NOT EXISTS inventory_reserved_insert BEFORE INSERT ON inventory
    WHEN NEW.qty<COALESCE((SELECT SUM(qty) FROM stock_reservation WHERE node_id=NEW.node_id AND item_id=NEW.item_id),0)
      OR EXISTS(SELECT 1 FROM inventory old JOIN stock_reservation r ON r.node_id=old.node_id AND r.item_id=old.item_id
        WHERE old.id=NEW.id AND (old.node_id!=NEW.node_id OR old.item_id!=NEW.item_id))
    BEGIN SELECT RAISE(ABORT,'库存已被任务预占，不能覆盖或更改归属'); END;
    CREATE TRIGGER IF NOT EXISTS inventory_reserved_update BEFORE UPDATE OF qty ON inventory
    WHEN NEW.qty<COALESCE((SELECT SUM(qty) FROM stock_reservation WHERE node_id=OLD.node_id AND item_id=OLD.item_id),0)
    BEGIN SELECT RAISE(ABORT,'库存已被任务预占，请先完成、调整或取消对应任务'); END;
    CREATE TRIGGER IF NOT EXISTS inventory_reserved_delete BEFORE DELETE ON inventory
    WHEN EXISTS(SELECT 1 FROM stock_reservation WHERE node_id=OLD.node_id AND item_id=OLD.item_id)
    BEGIN SELECT RAISE(ABORT,'库存已被任务预占，请先完成或取消对应任务'); END;
    CREATE TRIGGER IF NOT EXISTS inventory_reserved_relocate BEFORE UPDATE OF node_id,item_id ON inventory
    WHEN (NEW.node_id!=OLD.node_id OR NEW.item_id!=OLD.item_id) AND EXISTS(SELECT 1 FROM stock_reservation WHERE node_id=OLD.node_id AND item_id=OLD.item_id)
    BEGIN SELECT RAISE(ABORT,'库存已被任务预占，不能直接更改归属格位或货品'); END;
    CREATE TRIGGER IF NOT EXISTS item_reserved_delete BEFORE DELETE ON item
    WHEN EXISTS(SELECT 1 FROM stock_reservation WHERE item_id=OLD.id)
    BEGIN SELECT RAISE(ABORT,'货品已被任务预占，不能删除'); END;
    CREATE TRIGGER IF NOT EXISTS node_reserved_delete BEFORE DELETE ON space_node
    WHEN EXISTS(SELECT 1 FROM stock_reservation WHERE node_id=OLD.id)
    BEGIN SELECT RAISE(ABORT,'格位已被任务预占，不能删除'); END;`);
}

export function reservationQuantities(sql){return new Map(sql.prepare('SELECT node_id,item_id,SUM(qty) AS qty FROM stock_reservation GROUP BY node_id,item_id').all().map(row=>[row.node_id+':'+row.item_id,row.qty]));}
export function stockAvailability(item,nodeId,reservations){const reserved=reservations.get(nodeId+':'+(item.item_id||item.id))||0;return reserved?{...item,reserved_qty:reserved,available_qty:Math.max(0,item.qty-reserved)}:item;}
