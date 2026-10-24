import {createHash} from 'node:crypto';

export function sceneRevision(scene) {
  return createHash('sha256').update(JSON.stringify({room:scene.room,roomCode:scene.roomCode,furniture:scene.furniture,assets:scene.assets,sync:scene.sync})).digest('hex');
}

// 只发布已提交场景的摘要，不在长连接上传送库存或跨仓信息。
export function mountLiveScene(app,{readScene,authorize,intervalMs=1000}) {
  app.get('/api/scene/revision',async(req,res)=>{
    try {
      if(!await authorize(req))return res.status(403).json({error:'当前账号无权订阅此库区'});
      res.set('Cache-Control','no-store').json({revision:sceneRevision(await readScene(req))});
    }
    catch {res.status(503).json({error:'暂时无法检查库存更新'});}
  });
  app.get('/api/scene/events',async(req,res)=>{
    let closed=false,timer,last='',verifiedAt=Date.now();
    const stop=()=>{closed=true;clearTimeout(timer);};
    res.on('close',stop);
    try {
      if(!await authorize(req))return res.status(403).json({error:'当前账号无权订阅此库区'});
      const first=sceneRevision(await readScene(req));
      res.set({'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Accel-Buffering':'no'});
      res.flushHeaders();
      const send=revision=>{res.write(`data: ${JSON.stringify({revision})}\n\n`);last=revision;};
      send(first);
      const tick=async()=>{
        try {
          let revision=sceneRevision(await readScene(req));
          if(revision!==last || Date.now()-verifiedAt>=15000){
            if(!await authorize(req)){res.write('event: access-expired\ndata: {}\n\n');res.end();stop();return;}
            verifiedAt=Date.now();
            revision=sceneRevision(await readScene(req));
            if(!closed){if(revision!==last)send(revision);else res.write(': heartbeat\n\n');}
          }
        } catch {res.end();stop();}
        if(!closed)timer=setTimeout(tick,intervalMs);
      };
      timer=setTimeout(tick,intervalMs);
    }catch {if(!res.headersSent)res.status(503).json({error:'暂时无法订阅库存更新'});else res.end();stop();}
  });
}
