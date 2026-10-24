export function installMovementBusiness(sql){sql.exec(`CREATE TABLE IF NOT EXISTS movement_business (
  movement_id INTEGER PRIMARY KEY,details TEXT NOT NULL);`);}
export function businessDetails(input={}){
  const result={};
  for(const [field,length] of [['recipient',80],['department',80],['purpose',300],['document_no',120]]){
    if(input[field]===undefined||input[field]===null||input[field]==='')continue;
    if(typeof input[field]!=='string'||input[field].trim().length>length)throw Error('领用人、部门、用途或业务单号格式不正确');
    result[field]=input[field].trim();
  }return result;
}
export function movementBusiness(sql,rows){
  if(!rows.length)return rows;
  const records=sql.prepare('SELECT movement_id,details FROM movement_business WHERE movement_id IN ('+rows.map(()=>'?').join(',')+')').all(...rows.map(row=>row.id));
  const details=new Map(records.map(row=>[row.movement_id,JSON.parse(row.details)]));
  return rows.map(row=>details.has(row.id)?{...row,business:details.get(row.id)}:row);
}
