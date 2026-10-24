// 米制通道路线：以现有货架/存放区投影为障碍，保留通行余量。
// 起点只接受入口或明确指定的格位，不推断人员实时位置。
const EPS=1e-7;
const distance=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
const round=value=>Math.round(value*1000)/1000;
const point=value=>({x:value.x,z:value.z});
const fail=message=>{throw Error(message);};

// 场景与布局接口字段名不同，统一后判断路线是否因空间编辑而失效。
export function routeLayoutKey(spec){
  const room=spec.room||spec.roomSize||{};
  return JSON.stringify({room:spec.roomCode,width:room.width,depth:room.depth,doors:room.door||[],
    furniture:(spec.furniture||[]).map(f=>({code:f.code,x:f.x??f.position?.[0]??0,z:f.z??f.position?.[2]??0,rot:f.rot??f.rotationY??f.rotation??0,w:f.w??f.width,d:f.d??f.depth,rows:f.rows,cols:f.cols,merges:f.merges||{}})).sort((a,b)=>a.code.localeCompare(b.code))});
}

class MinHeap{
  rows=[];
  push(id,cost){let n=this.rows.length;const row={id,cost};this.rows.push(row);while(n){const p=(n-1)>>1;if(this.rows[p].cost<=cost)break;this.rows[n]=this.rows[p];n=p;}this.rows[n]=row;}
  pop(){const first=this.rows[0],last=this.rows.pop();if(this.rows.length){let n=0;while(n*2+1<this.rows.length){let c=n*2+1;if(c+1<this.rows.length&&this.rows[c+1].cost<this.rows[c].cost)c++;if(this.rows[c].cost>=last.cost)break;this.rows[n]=this.rows[c];n=c;}this.rows[n]=last;}return first;}
}

export function createWarehouseRouter(layout,{clearance=.25,step=.25}={}){
  const {room,furniture=[]}=layout,w=Number(room.width),d=Number(room.depth);
  if(![w,d,clearance,step].every(Number.isFinite)||w<=clearance*2||d<=clearance*2||clearance<.1||step<.1)fail('库区尺寸或通行余量无效');
  const obstacles=furniture.map(f=>{
    if(![f.x,f.z,f.w,f.d,f.rot||0].every(Number.isFinite)||f.w<=0||f.d<=0)fail('请先补全货架尺寸与位置');
    return {...f,c:Math.cos(f.rot||0),s:Math.sin(f.rot||0),halfW:f.w/2+clearance,halfD:f.d/2+clearance};
  });
  const local=(p,f)=>({x:(p.x-f.x)*f.c-(p.z-f.z)*f.s,z:(p.x-f.x)*f.s+(p.z-f.z)*f.c});
  const world=(x,z,f)=>({x:f.x+x*f.c+z*f.s,z:f.z-x*f.s+z*f.c});
  const inRoom=p=>Math.abs(p.x)<=w/2-clearance+EPS&&Math.abs(p.z)<=d/2-clearance+EPS;
  function segmentClear(a,b){
    if(!inRoom(a)||!inRoom(b))return false;
    for(const f of obstacles){
      const p=local(a,f),q=local(b,f);let low=0,high=1,hit=true;
      for(const [key,half] of [['x',f.halfW],['z',f.halfD]]){
        const delta=q[key]-p[key];
        if(Math.abs(delta)<EPS){if(Math.abs(p[key])>half+EPS){hit=false;break;}}
        else{let l=(-half-p[key])/delta,h=(half-p[key])/delta;if(l>h)[l,h]=[h,l];low=Math.max(low,l);high=Math.min(high,h);if(low>high+EPS){hit=false;break;}}
      }
      if(hit)return false;
    }
    return true;
  }
  const minX=-w/2+clearance,minZ=-d/2+clearance;
  let nx,nz;
  // 大库区适当降低采样密度，避免一次预览占满服务；仍逐段检查实体碰撞。
  do{nx=Math.floor((w-clearance*2)/step)+1;nz=Math.floor((d-clearance*2)/step)+1;if(nx*nz>20000)step*=1.2;}while(nx*nz>20000);
  const coordinate=id=>({x:minX+(id%nx)*step,z:minZ+Math.floor(id/nx)*step});
  const free=new Uint8Array(nx*nz),edgeCache=new Map();
  for(let id=0;id<free.length;id++){const p=coordinate(id);free[id]=segmentClear(p,p)?1:0;}
  const edge=(a,b)=>{const key=Math.min(a,b)*free.length+Math.max(a,b);if(!edgeCache.has(key))edgeCache.set(key,segmentClear(coordinate(a),coordinate(b)));return edgeCache.get(key);};
  function connections(p){
    if(!segmentClear(p,p))return [];
    const cx=Math.round((p.x-minX)/step),cz=Math.round((p.z-minZ)/step),rows=[];
    for(let z=cz-1;z<=cz+1;z++)for(let x=cx-1;x<=cx+1;x++)if(x>=0&&x<nx&&z>=0&&z<nz){const id=z*nx+x;if(free[id]&&segmentClear(p,coordinate(id)))rows.push({id,cost:distance(p,coordinate(id))});}
    return rows;
  }
  function approach(code){
    const match=String(code).match(/^(.*)-L(\d+)-B(\d+)$/),f=match&&obstacles.find(f=>f.code===match[1]);
    if(!f)fail('路线中的格位不属于当前库区');
    const row=Number(match[2]),col=Number(match[3]);
    if(row<1||row>f.rows||col<1||col>f.cols)fail('路线中的格位已变化，请重新选择');
    const spans=f.merges?.['L'+match[2]]||[];
    if(spans.some(([a,b])=>col>a&&col<=b))fail('请使用合并后的主格位编号');
    const span=spans.find(([a])=>a===col),width=f.w/f.cols;
    // 与3D格位生成器使用相同列方向及合并格位中心；从货架正面靠近。
    return world(-f.w/2+width*(col-.5+(span?(span[1]-span[0])/2:0)),f.d/2+clearance+.05,f);
  }
  const doors=Array.isArray(room.door)?room.door:[];
  const entrances=doors.map((door,index)=>{
    const side=door.side,length=['front','back'].includes(side)?w:d;
    // 门的位置是沿墙0至1的比例，门宽沿用3D门符号的尺寸。
    const ratio=Number(door.offset??.5),offset=(ratio-.5)*length,width=Number(door.width??(door.double?Math.min(length*.8,2.2):Math.min(length*.45,1.1)));
    if(!['front','back','left','right'].includes(side)||!Number.isFinite(ratio)||ratio<0||ratio>1||!Number.isFinite(width)||width<clearance*2)return null;
    const half=length/2;
    if(Math.abs(offset)+width/2>half+EPS)return null;
    const p=['front','back'].includes(side)?{x:offset,z:(side==='front'?1:-1)*(d/2-clearance)}:{x:(side==='right'?1:-1)*(w/2-clearance),z:offset};
    return {index,label:`入口${index+1}（${{front:'前侧',back:'后侧',left:'左侧',right:'右侧'}[side]}）`,point:p};
  }).filter(Boolean);
  function origin({start_loc='',entry=0}={}){
    if(start_loc)return {kind:'location',loc_code:start_loc,label:'从格位附近出发：'+start_loc,point:approach(start_loc)};
    const door=entrances.find(v=>v.index===Number(entry));if(!door)fail('请先设置可用入口，或选择当前所在格位附近作为起点');
    return {kind:'entrance',...door};
  }
  function pathsFrom(start,targets){
    const dist=new Float64Array(free.length).fill(Infinity),parent=new Int32Array(free.length).fill(-1),heap=new MinHeap();
    for(const c of connections(start)){dist[c.id]=c.cost;heap.push(c.id,c.cost);}
    while(heap.rows.length){
      const current=heap.pop();if(current.cost!==dist[current.id])continue;
      const x=current.id%nx,z=Math.floor(current.id/nx);
      for(const id of [x>0?current.id-1:-1,x<nx-1?current.id+1:-1,z>0?current.id-nx:-1,z<nz-1?current.id+nx:-1]){
        if(id<0||!free[id]||!edge(current.id,id))continue;
        const next=current.cost+step;if(next<dist[id]-EPS){dist[id]=next;parent[id]=current.id;heap.push(id,next);}
      }
    }
    return targets.map(target=>{
      if(segmentClear(start,target.point))return {...target,points:[start,target.point],distance:distance(start,target.point)};
      let best;for(const c of connections(target.point))if(Number.isFinite(dist[c.id])&&(!best||dist[c.id]+c.cost<best.cost))best={id:c.id,cost:dist[c.id]+c.cost};
      if(!best)return {...target,points:[],distance:null};
      const nodes=[];let id=best.id;while(id>=0){nodes.push(coordinate(id));id=parent[id];}nodes.reverse();
      const raw=[start,...nodes,target.point],smooth=[start];let from=0;
      while(from<raw.length-1){let to=raw.length-1;while(to>from+1&&!segmentClear(raw[from],raw[to]))to--;smooth.push(raw[to]);from=to;}
      return {...target,points:smooth,distance:smooth.slice(1).reduce((n,p,i)=>n+distance(smooth[i],p),0)};
    });
  }
  function plan(input){
    const locations=[...new Set(input.locations||[])];if(!locations.length||locations.length>50)fail('每次请选择1至50个格位');
    const start=origin(input);if(!connections(start.point).length)fail('起点附近没有可通行空间，请核对入口或货架摆放');
    let pending=locations.map(loc_code=>({loc_code,point:approach(loc_code)})),current=start.point,total=0;const stops=[],unreachable=[],points=[current];
    while(pending.length){
      const choices=pathsFrom(current,pending).filter(v=>v.distance!==null).sort((a,b)=>a.distance-b.distance||a.loc_code.localeCompare(b.loc_code));
      if(!choices.length){unreachable.push(...pending.map(v=>v.loc_code));break;}
      const next=choices[0];total+=next.distance;stops.push({...next,point:point(next.point),points:next.points.map(point),distance:round(next.distance),index:stops.length+1});points.push(...next.points.slice(1));current=next.point;pending=pending.filter(v=>v.loc_code!==next.loc_code);
    }
    return {room:layout.roomCode,layout_revision:layout.revision,layout_key:routeLayoutKey(layout),origin:{...start,point:point(start.point)},stops,unreachable,points:points.map(point),distance:round(total),clearance,grid_step:round(step),warnings:['路线按当前布局及货架正面规划，请核对现场可通行情况。','按就近顺序依次取货，未计算人员实时位置。']};
  }
  return {plan,approach,origin,pathsFrom,segmentClear,entrances};
}
