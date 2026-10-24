// 流水保存发生时的物料与库位，不依赖仍然存活的业务主表。
export function installMovementHistory(sql) {
  if (!sql.prepare('PRAGMA table_info(movement)').all().some(c=>c.name==='history_json')) sql.exec('ALTER TABLE movement ADD COLUMN history_json TEXT');
  const hasUnit=sql.prepare('PRAGMA table_info(item)').all().some(c=>c.name==='unit');
  const context = (id,captureUnit=false) => `json_object(
    'item_name',(SELECT name FROM item WHERE id=${id}.item_id),
    'sku',(SELECT sku FROM item WHERE id=${id}.item_id),
    'unit',${captureUnit&&hasUnit?`(SELECT unit FROM item WHERE id=${id}.item_id)`:'NULL'},
    'erp_code',(SELECT external_id FROM external_mapping WHERE external_system='erp' AND local_type='item' AND local_id=${id}.item_id LIMIT 1),
    'from_loc',(SELECT loc_code FROM space_node WHERE id=${id}.from_node_id),
    'to_loc',(SELECT loc_code FROM space_node WHERE id=${id}.to_node_id),
    'from_erp_loc',(SELECT external_id FROM external_mapping WHERE external_system='erp' AND local_type='node' AND local_id=${id}.from_node_id LIMIT 1),
    'to_erp_loc',(SELECT external_id FROM external_mapping WHERE external_system='erp' AND local_type='node' AND local_id=${id}.to_node_id LIMIT 1))`;
  sql.exec(`UPDATE movement SET history_json=${context('movement')} WHERE history_json IS NULL;
    DROP TRIGGER IF EXISTS movement_capture_context;
    CREATE TRIGGER movement_capture_context AFTER INSERT ON movement
    WHEN NEW.history_json IS NULL BEGIN
      UPDATE movement SET history_json=${context('NEW',true)} WHERE id=NEW.id;
    END;
    CREATE INDEX IF NOT EXISTS idx_movement_history_from ON movement(json_extract(history_json,'$.from_loc'));
    CREATE INDEX IF NOT EXISTS idx_movement_history_to ON movement(json_extract(history_json,'$.to_loc'));`);
}
