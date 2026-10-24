import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {resolveEventLocation} from '../apps/api/event-location.mjs';
import {SupOSAdapter} from '../packages/integration/adapters/suposUnsAdapter.mjs';

test('MQTT物料标识：内部ID与SKU独立，未提供SKU时不伪造',async()=>{
 const adapter=new SupOSAdapter('packages/integration/mapping/supos-uns.yaml');
 const bodies=[];adapter.publish=async(_topic,body)=>{bodies.push(body);return {ok:true};};
 const payload={loc_code:'WH-1-A-L01-B01',item_id:'internal-uuid',qty:7,_idem:'event-1'};
 await adapter.send('inventory.changed',payload);
 assert.equal(bodies[0].item_id,'internal-uuid');assert.equal(bodies[0].quantity,7);
 assert.equal('sku' in bodies[0],false);
 await adapter.send('inventory.changed',{...payload,sku:'BEARING-6204'});
 assert.equal(bodies[1].sku,'BEARING-6204');assert.equal(bodies[1].item_id,'internal-uuid');
});
test('事件库位：UUID解析、删除后历史恢复、歧义拒绝及MQTT路径隔离',()=>{
 const sql=new DatabaseSync(':memory:');
 try {
 sql.exec('CREATE TABLE space_node(id TEXT,loc_code TEXT);CREATE TABLE movement(from_node_id TEXT,to_node_id TEXT,history_json TEXT);');
 sql.prepare('INSERT INTO space_node VALUES(?,?)').run('uuid-1','WH-1-A-L01-B01');
 const original={node_id:'uuid-1',qty:5};const frozen=resolveEventLocation(sql,original);
 assert.equal(frozen.loc_code,'WH-1-A-L01-B01');assert.equal(original.loc_code,undefined);
 sql.exec('DELETE FROM space_node');
 assert.equal(resolveEventLocation(sql,original).loc_code,undefined);
 sql.prepare('INSERT INTO movement VALUES(?,?,?)').run(null,'uuid-1',JSON.stringify({to_loc:'WH-1-A-L01-B01'}));
 assert.equal(resolveEventLocation(sql,original).loc_code,frozen.loc_code);
 sql.prepare('INSERT INTO movement VALUES(?,?,?)').run('uuid-1',null,JSON.stringify({from_loc:'WH-2-A-L01-B01'}));
 assert.equal(resolveEventLocation(sql,original).loc_code,undefined);
 assert.equal(resolveEventLocation(sql,frozen).loc_code,frozen.loc_code);
 const adapter=new SupOSAdapter('packages/integration/mapping/supos-uns.yaml');
 assert.equal(adapter.topicFor('inventory.changed',original),null);
 assert.match(adapter.topicFor('inventory.changed',frozen),/WH-1\/rack\/A\/layer\/L01\/bin\/B01\/quantity$/);
 assert.ok(adapter.topicFor('inventory.changed',{loc_code:'foreign/+'}).includes('foreign%2F%2B'));
 }finally{sql.close();}
});
