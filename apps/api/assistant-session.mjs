import {randomUUID} from 'node:crypto';

// 作业上下文属于账号和当前浏览器会话；不由模型或客户端伪造查询结果。
export function createAssistantSessions({now=Date.now,ttl=2*60*60*1000}={}){
  const sessions=new Map();
  function get(req){
    const id=req.body?.session_id||req.query?.session_id||randomUUID();
    if(!/^[a-zA-Z0-9_-]{1,80}$/.test(id))throw Error('助手会话编号无效');
    for(const [key,value] of sessions)if(now()-value.at>ttl)sessions.delete(key);
    const key=req.user.id+':'+id,room=req.body?.room||req.query?.room;
    let session=sessions.get(key);
    if(!session){session={id,room,history:[],pending:null,lastStock:[],state:'idle',ahead:0,at:now()};sessions.set(key,session);}
    if(session.room!==room){if(session.state!=='idle')throw Object.assign(Error('助手正在处理原库区请求，请完成后再使用新库区上下文'),{status:409});session.room=room;session.history=[];session.pending=null;session.lastStock=[];session.jobId=null;}
    session.at=now();return session;
  }
  function remember(session,name,input,result,message){
    if(result.kind==='job'){session.jobId=result.id;session.pending=null;}
    if(result.kind==='stock')session.lastStock=result.rows.slice(0,8);
    if(['draft','setup','opening','recommendations','stocktake'].includes(result.kind)){session.pending={name,input:result.input||input};session.jobId=null;}
    if(message)session.history.push({message:String(message).slice(0,300),tool:name});session.history=session.history.slice(-4);
  }
  function reset(session){session.history=[];session.pending=null;session.lastStock=[];session.jobId=null;}
  return {get,remember,reset};
}
