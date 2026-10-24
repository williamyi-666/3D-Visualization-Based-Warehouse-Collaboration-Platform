import {DatabaseSync} from 'node:sqlite';
if(process.env.SPATIAL_DATA_DIR!=='/audit-data')throw Error('仅允许隔离卷');
const db=await import('/app/apps/api/db.mjs');
const sql=new DatabaseSync('/audit-data/spatial.db');
if(!sql.prepare('SELECT id FROM space_node WHERE loc_code=?').get('QA'))db.createSite({code:'QA',name:'QA <b>仓库</b> & "引号"'});
sql.prepare('UPDATE space_node SET name=? WHERE loc_code=?').run('QA <b>库区</b> & "引号"','QA-1');
sql.close();console.log('隔离导航数据已准备');
