import {bendGeometry} from './bend-geometry.mjs';
import {roadPath,slicePath,pathPointAt,samplePath,sampleCubic,makePath} from './geometry.mjs';
import {laneCounts,roadWidth,LANE_WIDTH} from './lanes.mjs';
import {convexJunctionPolygon as localHull,junctionLayout} from './junction-layout.mjs';
import {terminalIds} from './terminals.mjs';

const EPS=1e-6;
const dot=(a,b)=>a.x*b.x+a.z*b.z;
const roadFor=(network,arm)=>arm.road||network.roads.find(road=>road.id===arm.roadId);
function directions(network,arm){
  const count=laneCounts(roadFor(network,arm));
  return arm.end==='a'?{incoming:count.backward,outgoing:count.forward}:{incoming:count.forward,outgoing:count.backward};
}
function incomingCenterline(network,arm,node){
  const road=roadFor(network,arm),path=roadPath(network,road),trim=Math.max(0,Math.min(path.length,arm.trim));
  if(trim<EPS)return [{x:node.x,z:node.z}];
  const points=arm.end==='a'?slicePath(path,0,trim).reverse():slicePath(path,path.length-trim,path.length);
  points[points.length-1]={x:node.x,z:node.z};return points;
}

// Select geometry for visual through-corridor markings, never a routing decision.
// Priority is shared width, then opposition, then IDs so drawing does not depend on
// node/road insertion order. Actual legal movement paths remain the engine's source.
export function dominantThroughPair(network,layout){
  if(!layout||layout.arms.length<2)return null;
  const candidates=[];
  for(let i=0;i<layout.arms.length;i++)for(let j=i+1;j<layout.arms.length;j++){
    let a=layout.arms[i],b=layout.arms[j];if(a.roadId.localeCompare(b.roadId)>0)[a,b]=[b,a];
    const opposition=dot(a.outward,b.outward);if(opposition>=-.85)continue;
    const da=directions(network,a),db=directions(network,b),movements=[];
    if(da.incoming&&db.outgoing)movements.push({fromRoadId:a.roadId,toRoadId:b.roadId,fromEnd:a.end,toEnd:b.end,laneCount:Math.min(da.incoming,db.outgoing)});
    if(db.incoming&&da.outgoing)movements.push({fromRoadId:b.roadId,toRoadId:a.roadId,fromEnd:b.end,toEnd:a.end,laneCount:Math.min(db.incoming,da.outgoing)});
    if(!movements.length)continue;
    candidates.push({a,b,dot:opposition,width:Math.min(a.width,b.width),movements,key:`${a.roadId}\0${b.roadId}`});
  }
  candidates.sort((a,b)=>b.width-a.width||a.dot-b.dot||a.key.localeCompare(b.key));
  const selected=candidates[0];if(!selected)return null;
  const node=network.nodes.find(node=>node.id===layout.nodeId),from=incomingCenterline(network,selected.a,node),to=incomingCenterline(network,selected.b,node).reverse();
  const centerline=[...from,...to.slice(1)];
  return {nodeId:layout.nodeId,roadIds:[selected.a.roadId,selected.b.roadId],arms:[selected.a,selected.b],dot:selected.dot,width:selected.width,movements:selected.movements,
    markings:{centerline,fromWidth:selected.a.width,toWidth:selected.b.width,halfWidth:selected.width/2}};
}


const EMPTY_CONNECTIONS=[];
const footprintCache=new WeakMap(),coverageCache=new WeakMap();
const finite=value=>typeof value==='number'&&Number.isFinite(value);
export function vehicleFootprint(pose,length,width,margin=0){
  const forward={x:Math.sin(pose.yaw),z:Math.cos(pose.yaw)},side={x:Math.cos(pose.yaw),z:-Math.sin(pose.yaw)},halfLength=length/2+margin,halfWidth=width/2+margin;
  return [-1,1].flatMap(along=>[-1,1].map(across=>({x:pose.x+forward.x*halfLength*along+side.x*halfWidth*across,z:pose.z+forward.z*halfLength*along+side.z*halfWidth*across})));
}
const polygonArea=polygon=>polygon.reduce((sum,p,i)=>{const q=polygon[(i+1)%polygon.length];return sum+p.x*q.z-q.x*p.z;},0)/2;
const edgeKey=(a,b)=>`${a.x.toFixed(6)},${a.z.toFixed(6)}>${b.x.toFixed(6)},${b.z.toFixed(6)}`;
const polygonKey=polygon=>polygon.map(p=>`${p.x},${p.z}`).join(';');
function mergeRoadQuads(pieces){
  const active=new Set(),edges=new Map(),seen=new Set();
  const remove=record=>{active.delete(record);for(let i=0;i<record.polygon.length;i++){const key=edgeKey(record.polygon[i],record.polygon[(i+1)%record.polygon.length]),set=edges.get(key);set?.delete(record);if(!set?.size)edges.delete(key);}};
  const insert=record=>{active.add(record);for(let i=0;i<record.polygon.length;i++){const key=edgeKey(record.polygon[i],record.polygon[(i+1)%record.polygon.length]);if(!edges.has(key))edges.set(key,new Set());edges.get(key).add(record);}};
  for(const piece of pieces){
    const originalKey=polygonKey(piece.polygon);if(seen.has(originalKey))continue;seen.add(originalKey);
    let polygon=piece.polygon;
    for(;;){
      let match=null,hull=null;
      for(let i=0;i<polygon.length&&!match;i++)for(const candidate of edges.get(edgeKey(polygon[(i+1)%polygon.length],polygon[i]))||[]){
        if(Math.abs(candidate.width-piece.width)>EPS)continue;
        const union=localHull([...polygon,...candidate.polygon]),sum=polygonArea(polygon)+polygonArea(candidate.polygon);
        // CCW polygons on opposite sides of their common edge have disjoint interiors.
        // Equality of hull area and their summed area proves their union is convex.
        if(Math.abs(polygonArea(union)-sum)<=Math.max(1e-8,sum*1e-10)){match=candidate;hull=union;break;}
      }
      if(!match)break;remove(match);polygon=hull;
    }
    insert({polygon,width:piece.width});
  }
  return [...active].map(record=>record.polygon);
}
function convexContains(polygon,point){
  for(let i=0;i<polygon.length;i++){const a=polygon[i],b=polygon[(i+1)%polygon.length];if((b.x-a.x)*(point.z-a.z)-(b.z-a.z)*(point.x-a.x)<-1e-7)return false;}return true;
}
function containedInOneRoad(polygon,roadPolygons,index){
  const center=polygon.reduce((p,q)=>({x:p.x+q.x/polygon.length,z:p.z+q.z/polygon.length}),{x:0,z:0});
  const candidates=index.cells.get(`${Math.floor(center.x/index.size)}:${Math.floor(center.z/index.size)}`)||[];
  const xs=polygon.map(p=>p.x),zs=polygon.map(p=>p.z),minX=Math.min(...xs),maxX=Math.max(...xs),minZ=Math.min(...zs),maxZ=Math.max(...zs);
  for(const id of candidates){const box=index.bounds[id];if(minX<box.minX-EPS||maxX>box.maxX+EPS||minZ<box.minZ-EPS||maxZ>box.maxZ+EPS)continue;if(polygon.every(point=>convexContains(roadPolygons[id],point)))return true;}return false;
}

/** Local CCW pieces of the visual pavement union. No hull is taken across roads
 * or movements: gaps between branch corridors remain background, not asphalt. */
function polygonContains(polygon,p){
  let inside=false;
  for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
    const a=polygon[j],b=polygon[i],dx=b.x-a.x,dz=b.z-a.z,qx=p.x-a.x,qz=p.z-a.z;
    if(dx*dx+dz*dz<1e-16)continue;
    if(Math.abs(dx*qz-dz*qx)<1e-7&&qx*dx+qz*dz>=-1e-7&&qx*dx+qz*dz<=dx*dx+dz*dz+1e-7)return true;
    if((a.z>p.z)!==(b.z>p.z)&&p.x<(b.x-a.x)*(p.z-a.z)/(b.z-a.z)+a.x)inside=!inside;
  }return inside;
}
function selfIntersects(polygon){
  const cross=(a,b,c)=>(b.x-a.x)*(c.z-a.z)-(b.z-a.z)*(c.x-a.x);
  for(let i=0;i<polygon.length;i++)for(let j=i+2;j<polygon.length;j++){
    if(i===0&&j===polygon.length-1)continue;
    const a=polygon[i],b=polygon[(i+1)%polygon.length],c=polygon[j],d=polygon[(j+1)%polygon.length];
    if(cross(a,b,c)*cross(a,b,d)<-1e-9&&cross(c,d,a)*cross(c,d,b)<-1e-9)return true;
  }return false;
}
const bendCache=new WeakMap();
export function cornerBends(network,curbMargin=0,connections=EMPTY_CONNECTIONS,{vehicleLength=10.923,vehicleWidth=3.0224,margin=.65}={}){
  const cacheKey=`${vehicleLength}:${vehicleWidth}:${margin}`;
  let cached=bendCache.get(network);
  if(!cached||cached.connections!==connections){cached={connections,variants:new Map()};bendCache.set(network,cached);}
  let base=cached.variants.get(cacheKey);
  if(!base){
    base=new Map();
    const layout=junctionLayout(network);
    for(const junction of layout.nodes){
      const geometry=bendGeometry(network,junction.nodeId);if(!geometry)continue;
      const {a,b}=geometry;
      const visualArm=arm=>{
        const path=roadPath(network,arm.road),other=layout.byNode.get(arm.end==='a'?arm.road.b:arm.road.a).arms.find(x=>x.roadId===arm.roadId);
        const collar=Math.min(vehicleLength+margin,Math.max(0,(path.length-arm.trim-other.trim-4)*.4));
        return {...arm,renderTrim:arm.trim+collar};
      };
      const va=visualArm(a),vb=visualArm(b);
      const collarFrames=(arm,incoming)=>{
        if(arm.renderTrim-arm.trim<1e-6)return [];
        const path=roadPath(network,arm.road),at=t=>arm.end==='a'?t:path.length-t;
        const first=at(incoming?arm.renderTrim:arm.trim),last=at(incoming?arm.trim:arm.renderTrim);
        let points=samplePath(path,Math.min(first,last),Math.max(first,last),.6);if(first>last)points=points.reverse();
        const sign=(arm.end==='a'?1:-1)*(incoming?-1:1);
        return points.map(p=>({x:p.x,z:p.z,nx:p.tangentZ*sign,nz:-p.tangentX*sign,half:arm.width/2,blend:incoming?0:1}));
      };
      const frames=[...collarFrames(va,true).slice(0,-1),...geometry.frames,...collarFrames(vb,false).slice(1)];
      const path=makePath(frames),widths=frames.map(()=>({right:0,left:0}));
      const roadPolygons=[];
      for(const arm of [va,vb]){
        const rp=roadPath(network,arm.road),other=layout.byNode.get(arm.end==='a'?arm.road.b:arm.road.a).arms.find(x=>x.roadId===arm.roadId);
        const start=arm.end==='a'?arm.renderTrim:other.trim,end=rp.length-(arm.end==='b'?arm.renderTrim:other.trim),half=arm.width/2;
        const samples=samplePath(rp,start,end,1.5);
        for(let i=1;i<samples.length;i++)roadPolygons.push(localHull([pathPointAt(rp,samples[i-1].s,-half),pathPointAt(rp,samples[i-1].s,half),pathPointAt(rp,samples[i].s,-half),pathPointAt(rp,samples[i].s,half)]));
      }
      const roadIndex=coverageIndex(roadPolygons),targets=[];
      const onRoad=p=>(roadIndex.cells.get(`${Math.floor(p.x/roadIndex.size)}:${Math.floor(p.z/roadIndex.size)}`)||[]).some(i=>convexContains(roadPolygons[i],p));
      for(const connection of connections)if(connection.nodeId===junction.nodeId&&!connection.uTurn){
        for(let i=1;i<connection.points.length;i++){
          const p=connection.points[i-1],q=connection.points[i],dy=Math.atan2(Math.sin(q.yaw-p.yaw),Math.cos(q.yaw-p.yaw));
          for(let j=0;j<=2;j++){const t=j/2;for(const v of vehicleFootprint({x:p.x+(q.x-p.x)*t,z:p.z+(q.z-p.z)*t,yaw:p.yaw+dy*t},vehicleLength,vehicleWidth,margin+.04))if(!onRoad(v))targets.push(v);}
        }
      }
      // Fit local clearance directly in metres. No division by a taper near zero.
      const requirements=[];
      for(const p of targets){
        let nearest=null;
        for(let i=1;i<frames.length;i++){
          const a=frames[i-1],b=frames[i],dx=b.x-a.x,dz=b.z-a.z,t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.z-a.z)*dz)/(dx*dx+dz*dz||1))),x=a.x+dx*t,z=a.z+dz*t,d=(p.x-x)**2+(p.z-z)**2;
          if(!nearest||d<nearest.d)nearest={i,t,x,z,d};
        }
        const a=frames[nearest.i-1],b=frames[nearest.i],t=nearest.t,nx=a.nx+(b.nx-a.nx)*t,nz=a.nz+(b.nz-a.nz)*t;
        const offset=(p.x-nearest.x)*nx+(p.z-nearest.z)*nz,half=a.half+(b.half-a.half)*t,needed=Math.max(0,Math.abs(offset)-half+.08);
        if(needed>0)requirements.push({s:path.distances[nearest.i-1]+(path.distances[nearest.i]-path.distances[nearest.i-1])*t,side:offset>0?'right':'left',needed});
      }
      const support=Math.max(3,vehicleLength*.75);
      for(const r of requirements)for(let i=0;i<frames.length;i++){
        const distance=Math.abs(path.distances[i]-r.s),t=Math.max(0,1-distance/support),weight=t*t*(3-2*t);
        widths[i][r.side]=Math.max(widths[i][r.side],r.needed*weight);
      }
      // A short plateau around each requirement covers sampling interpolation.
      for(const r of requirements)for(let i=0;i<frames.length;i++)if(Math.abs(path.distances[i]-r.s)<1)widths[i][r.side]=Math.max(widths[i][r.side],r.needed);
      const boundary=(side,extra=0)=>frames.map((p,i)=>{const sign=side==='right'?1:-1,offset=p.half+widths[i][side]+extra;return{x:p.x+p.nx*offset*sign,z:p.z+p.nz*offset*sign};});
      let outer=boundary('right'),inner=boundary('left'),polygon=[...outer,...inner.slice().reverse()];
      const smoothGeometry=!selfIntersects(polygon),coverageComplete=smoothGeometry&&targets.every(p=>polygonContains(polygon,p));
      const da=directions(network,a),db=directions(network,b),ca=laneCounts(a.road),cb=laneCounts(b.road),markings=[];
      const div=(counts)=>(counts.backward-counts.total/2)*LANE_WIDTH;
      const divA=div(ca)*(a.end==='a'?1:-1),divB=div(cb)*(b.end==='a'?-1:1);
      const laneLine=(oa,ob)=>frames.map(p=>{const offset=oa+(ob-oa)*p.blend;return{x:p.x+p.nx*offset,z:p.z+p.nz*offset};});
      let centerCurve=null;
      if(!a.road.oneWay&&!b.road.oneWay){centerCurve=laneLine(divA,divB);markings.push({points:centerCurve,divider:true});}
      for(const [from,to,side] of [[da.incoming,db.outgoing,-1],[da.outgoing,db.incoming,1]])if(from===to)for(let i=1;i<from;i++)markings.push({points:laneLine(divA+side*i*LANE_WIDTH,divB+side*i*LANE_WIDTH),divider:false});
      const offsetBoundary=(points,distance,sign)=>boundary(sign>0?'right':'left',distance);
      const fallbackPolygon=smoothGeometry?null:localHull(polygon);
      base.set(junction.nodeId,{nodeId:junction.nodeId,roadA:a.road,roadB:b.road,trimA:va.renderTrim,trimB:vb.renderTrim,renderTrimA:va.renderTrim,renderTrimB:vb.renderTrim,coverageComplete,smoothGeometry,fallbackPolygon,surfaceOuter:smoothGeometry?outer:[],surfaceInner:smoothGeometry?inner:[],outerCurve:smoothGeometry?boundary('right',-.45):[],innerCurve:smoothGeometry?boundary('left',-.45):[],centerCurve,markings,divider:!!centerCurve,offsetBoundary});
    }
    cached.variants.set(cacheKey,base);
  }
  const result=new Map();for(const [id,bend] of base){const surfaceOuter=curbMargin&&bend.surfaceOuter.length?bend.offsetBoundary(bend.surfaceOuter,curbMargin,1):bend.surfaceOuter,surfaceInner=curbMargin&&bend.surfaceInner.length?bend.offsetBoundary(bend.surfaceInner,curbMargin,-1):bend.surfaceInner;result.set(id,{...bend,surfaceOuter,surfaceInner,polygon:bend.fallbackPolygon||[...surfaceOuter,...surfaceInner.slice().reverse()]});}return result;
}

const junctionSurfaceCache=new WeakMap();
/** A single concave, tangent-continuous outline for each multi-arm junction.
 * Corner geometry depends on physical mouths, never legal lane movements. */
export function junctionSurfaces(network,connections=EMPTY_CONNECTIONS,{vehicleLength=10.923,vehicleWidth=3.0224,margin=.65}={}){
  const key=`${vehicleLength}:${vehicleWidth}:${margin}`;
  let cached=junctionSurfaceCache.get(network);
  if(!cached||cached.connections!==connections){cached={connections,variants:new Map()};junctionSurfaceCache.set(network,cached);}
  if(cached.variants.has(key))return cached.variants.get(key);
  const surfaces=new Map(),layout=junctionLayout(network);
  for(const junction of layout.nodes){
    if(junction.arms.length<3)continue;
    const mouths=[...junction.arms].map(arm=>{
      const path=roadPath(network,arm.road),otherNode=layout.byNode.get(arm.end==='a'?arm.road.b:arm.road.a),other=otherNode.arms.find(a=>a.roadId===arm.roadId),ports=new Set([...terminalIds(network,'source'),...terminalIds(network,'sink')]),reserve=otherNode.arms.length===1&&!arm.road.oneWay&&!ports.has(otherNode.nodeId)?Math.max(other.trim,Math.min(path.length*.45,vehicleLength+margin)):other.trim,collar=Math.min(vehicleLength+margin,Math.max(0,(path.length-arm.trim-reserve-4)*.45)),trim=arm.trim+collar,p=pathPointAt(path,arm.end==='a'?trim:path.length-trim),sign=arm.end==='a'?1:-1,outward={x:p.tangentX*sign,z:p.tangentZ*sign},normal={x:-outward.z,z:outward.x};
      return {...arm,engineTrim:arm.trim,renderTrim:trim,trim,center:{x:p.x,z:p.z},outward,left:{x:p.x+normal.x*arm.width/2,z:p.z+normal.z*arm.width/2},right:{x:p.x-normal.x*arm.width/2,z:p.z-normal.z*arm.width/2}};
    }).sort((a,b)=>Math.atan2(a.outward.z,a.outward.x)-Math.atan2(b.outward.z,b.outward.x)||a.roadId.localeCompare(b.roadId));
    const side=(arm,offset)=>({x:arm.center.x-arm.outward.z*offset,z:arm.center.z+arm.outward.x*offset});
    const cornerSpecs=mouths.map((arm,i)=>{
      const next=mouths[(i+1)%mouths.length],p=side(arm,arm.width/2),q=side(next,-next.width/2),den=arm.outward.x*next.outward.z-arm.outward.z*next.outward.x,dx=q.x-p.x,dz=q.z-p.z;
      let gap=Math.atan2(next.outward.z,next.outward.x)-Math.atan2(arm.outward.z,arm.outward.x);if(gap<=0)gap+=Math.PI*2;
      const turn=Math.abs(Math.PI-gap),factor=turn<.01?2/3:4/3*Math.tan(turn/4)/Math.max(.001,Math.tan(turn/2));
      const ta=Math.abs(den)>.001?(-dx*next.outward.z+dz*next.outward.x)/den:Math.hypot(dx,dz)/2;
      const tb=Math.abs(den)>.001?(arm.outward.x*dz-arm.outward.z*dx)/den:Math.hypot(dx,dz)/2;
      const span=Math.hypot(dx,dz),ka=Math.min(span*.8,Math.max(.1,ta*factor)),kb=Math.min(span*.8,Math.max(.1,tb*factor));
      return {arm,next,p,q,ka,kb,steps:Math.max(40,Math.min(128,Math.ceil(span/.6)))};
    });
    const coverage=[];
    for(const arm of mouths){const path=roadPath(network,arm.road),other=layout.byNode.get(arm.end==='a'?arm.road.b:arm.road.a).arms.find(a=>a.roadId===arm.roadId),start=arm.end==='a'?arm.trim:other.trim,end=path.length-(arm.end==='b'?arm.trim:other.trim),samples=samplePath(path,start,end,3);for(let i=1;i<samples.length;i++)coverage.push(localHull([pathPointAt(path,samples[i-1].s,-arm.width/2),pathPointAt(path,samples[i-1].s,arm.width/2),pathPointAt(path,samples[i].s,-arm.width/2),pathPointAt(path,samples[i].s,arm.width/2)]));}
    const index=coverageIndex(coverage),targets=[],clearanceTargets=[],seen=new Set();
    for(const connection of connections)if(connection.nodeId===junction.nodeId)for(let i=1;i<connection.points.length;i++){
      const a=connection.points[i-1],b=connection.points[i],dy=Math.atan2(Math.sin(b.yaw-a.yaw),Math.cos(b.yaw-a.yaw));
      for(let j=0;j<=4;j++){const t=j/4,pose={x:a.x+(b.x-a.x)*t,z:a.z+(b.z-a.z)*t,yaw:a.yaw+dy*t};for(const [clearance,list,prefix] of [[.02,targets,'body'],[margin,clearanceTargets,'clearance']])for(const p of vehicleFootprint(pose,vehicleLength,vehicleWidth,clearance)){const id=`${prefix}:${p.x.toFixed(2)}:${p.z.toFixed(2)}`;if(seen.has(id))continue;seen.add(id);const candidates=index.cells.get(`${Math.floor(p.x/index.size)}:${Math.floor(p.z/index.size)}`)||[];if(!candidates.some(i=>convexContains(coverage[i],p)))list.push(p);}}
    }
    const curvesAt=roundness=>cornerSpecs.map(({arm,next,p,q,ka,kb,steps})=>{
      let p1={x:p.x-arm.outward.x*ka*roundness,z:p.z-arm.outward.z*ka*roundness},p2={x:q.x-next.outward.x*kb*roundness,z:q.z-next.outward.z*kb*roundness};
      const axisAligned=v=>Math.abs(v.x)<1e-8||Math.abs(v.z)<1e-8;
      if(axisAligned(arm.outward)&&axisAligned(next.outward)){
        const clamp=c=>({x:Math.max(Math.min(p.x,q.x),Math.min(Math.max(p.x,q.x),c.x)),z:Math.max(Math.min(p.z,q.z),Math.min(Math.max(p.z,q.z),c.z))});p1=clamp(p1);p2=clamp(p2);
      }
      return sampleCubic(p,p1,p2,q,steps);
    });
    const cleanPolygon=points=>{const clean=points.filter((p,i)=>!i||Math.hypot(p.x-points[i-1].x,p.z-points[i-1].z)>1e-8);if(clean.length>1&&Math.hypot(clean[0].x-clean.at(-1).x,clean[0].z-clean.at(-1).z)<1e-8)clean.pop();return clean;};
    const polygonFrom=curves=>cleanPolygon(curves.flatMap((curve,i)=>[side(mouths[i],-mouths[i].width/2),...curve]));
    let curves=curvesAt(1),polygon=polygonFrom(curves),roundness=1;
    // A bounded handle adjustment can open a corner toward its chamfer. Never
    // displace the corner along its normal: that produces protruding ears.
    if(!targets.every(p=>polygonContains(polygon,p))){
      const limit=polygonFrom(curvesAt(.05));
      if(targets.every(p=>polygonContains(limit,p)))for(let attempt=0;attempt<14&&!targets.every(p=>polygonContains(polygon,p));attempt++){roundness*=.8;curves=curvesAt(roundness);polygon=polygonFrom(curves);}
    }
    let smoothGeometry=!selfIntersects(polygon),coverageComplete=smoothGeometry&&targets.every(p=>polygonContains(polygon,p));
    const clearanceComplete=smoothGeometry&&clearanceTargets.every(p=>polygonContains(polygon,p));
    if(!smoothGeometry){polygon=localHull(mouths.flatMap(a=>[a.left,a.right]));curves=[];coverageComplete=false;}
    const offsetCurve=(points,distance,spec)=>{const path=makePath(points);return points.map((p,i)=>{const v=i===0?{dx:-spec.arm.outward.x,dz:-spec.arm.outward.z}:i===points.length-1?{dx:spec.next.outward.x,dz:spec.next.outward.z}:path.tangents[i];return{x:p.x+v.dz*distance,z:p.z-v.dx*distance};});};
    const curbCurves=curves.map((curve,i)=>offsetCurve(curve,1.35,cornerSpecs[i])),edgeCurves=curves.map((curve,i)=>offsetCurve(curve,-.45,cornerSpecs[i]));
    const curbPolygon=curbCurves.length?cleanPolygon(curbCurves.flatMap((curve,i)=>[side(mouths[i],-mouths[i].width/2-1.35),...curve])):localHull(mouths.flatMap(a=>[side(a,-a.width/2-1.35),side(a,a.width/2+1.35)]));
    surfaces.set(junction.nodeId,{nodeId:junction.nodeId,polygon,curbPolygon,edgeCurves,mouths,coverageComplete,clearanceComplete,smoothGeometry,roundness,bulge:0});
  }
  cached.variants.set(key,surfaces);return surfaces;
}

export function pavementFootprints(network,connections=EMPTY_CONNECTIONS,{vehicleLength=10.923,vehicleWidth=3.0224,margin=.65,curbMargin=0}={}){
  if(!finite(vehicleLength)||vehicleLength<=0||!finite(vehicleWidth)||vehicleWidth<=0||!finite(margin)||margin<0||!finite(curbMargin)||curbMargin<0)throw new Error('路面扫掠尺寸必须为有效非负数，车辆尺寸应大于零');
  const key=`${vehicleLength}:${vehicleWidth}:${margin}:${curbMargin}`;
  let cached=footprintCache.get(network);const ports=JSON.stringify([terminalIds(network,'source'),terminalIds(network,'sink')]);
  if(!cached||cached.roads!==network.roads||cached.nodes!==network.nodes||cached.ports!==ports||cached.connections!==connections){cached={roads:network.roads,nodes:network.nodes,ports,connections,variants:new Map()};footprintCache.set(network,cached);}
  if(cached.variants.has(key))return cached.variants.get(key);
  const roadPieces=[];
  const addRoad=(points,width)=>{const polygon=localHull(points);if(polygon.length>=3)roadPieces.push({polygon,width});};
  const bends = cornerBends(network,curbMargin,connections,{vehicleLength,vehicleWidth,margin});
  const junctions=junctionSurfaces(network,connections,{vehicleLength,vehicleWidth,margin});
  for(const road of network.roads){
    const path=roadPath(network,road),half=roadWidth(road)/2+curbMargin;
    const a=junctionLayout(network).byNode.get(road.a),b=junctionLayout(network).byNode.get(road.b);
    const bendA=bends.get(road.a),bendB=bends.get(road.b),bendTrim=bend=>bend.roadA.id===road.id?bend.trimA:bend.trimB;
    const junctionA=junctions.get(road.a)?.mouths.find(arm=>arm.roadId===road.id),junctionB=junctions.get(road.b)?.mouths.find(arm=>arm.roadId===road.id);
    const start=bendA?bendTrim(bendA):junctionA?junctionA.trim:a.arms.length>1?a.arms.find(arm=>arm.roadId===road.id).trim:0;
    const end=path.length-(bendB?bendTrim(bendB):junctionB?junctionB.trim:b.arms.length>1?b.arms.find(arm=>arm.roadId===road.id).trim:0);
    const samples=samplePath(path,start,end,3);
    for(let i=1;i<samples.length;i++){
      const s0=samples[i-1].s,s1=samples[i].s;
      addRoad([pathPointAt(path,s0,-half),pathPointAt(path,s0,half),pathPointAt(path,s1,-half),pathPointAt(path,s1,half)],half*2);
    }
  }
  for(const bend of bends.values()){if(bend.fallbackPolygon)addRoad(bend.fallbackPolygon,Math.max(roadWidth(bend.roadA),roadWidth(bend.roadB)));}
  for(const bend of bends.values())for(let i=1;i<bend.surfaceOuter.length;i++){
    addRoad([bend.surfaceOuter[i-1],bend.surfaceOuter[i],bend.surfaceInner[i],bend.surfaceInner[i-1]],Math.max(roadWidth(bend.roadA),roadWidth(bend.roadB)));
  }
  // Open terminal gates need enough straight pavement for a complete vehicle to
  // emerge or clear the exit before its rear crosses the logical boundary.
  for(const nodeId of new Set([...terminalIds(network,'source'),...terminalIds(network,'sink')])){
    const attached=network.roads.filter(road=>road.a===nodeId||road.b===nodeId);if(attached.length!==1)continue;
    const road=attached[0],path=roadPath(network,road),atStart=road.a===nodeId,pose=pathPointAt(path,atStart?0:path.length),sign=atStart?-1:1;
    const outside={x:pose.tangentX*sign,z:pose.tangentZ*sign},normal={x:-outside.z,z:outside.x},half=roadWidth(road)/2+curbMargin;
    const start={x:pose.x-outside.x*curbMargin,z:pose.z-outside.z*curbMargin},end={x:pose.x+outside.x*(vehicleLength+margin+curbMargin),z:pose.z+outside.z*(vehicleLength+margin+curbMargin)};
    addRoad([start,end].flatMap(point=>[-1,1].map(side=>({x:point.x+normal.x*half*side,z:point.z+normal.z*half*side}))),half*2);
  }
  const roadPolygons=mergeRoadQuads(roadPieces),roadIndex=coverageIndex(roadPolygons),polygons=[...roadPolygons],seen=new Set(polygons.map(polygonKey));
  const add=points=>{const polygon=localHull(points);if(polygon.length<3||containedInOneRoad(polygon,roadPolygons,roadIndex))return;const key=polygonKey(polygon);if(seen.has(key))return;seen.add(key);polygons.push(polygon);};
  for(const connection of connections){
    if(junctions.get(connection.nodeId)?.coverageComplete||bends.get(connection.nodeId)?.coverageComplete&&!connection.uTurn)continue;
    const poses=connection.points||connection.poses||[];
    if(!poses.length)continue;
    const laneW=connection.laneWidth||vehicleWidth;
    const halfWidth=laneW/2+margin+curbMargin;
    for(let i=1;i<poses.length;i++){
      const p0=poses[i-1],p1=poses[i];
      if(!finite(p0.x)||!finite(p0.z)||!finite(p0.yaw)||!finite(p1.x)||!finite(p1.z)||!finite(p1.yaw))throw new Error('连接器车身姿态必须为有限数值');
      const n0={x:Math.cos(p0.yaw),z:-Math.sin(p0.yaw)};
      const n1={x:Math.cos(p1.yaw),z:-Math.sin(p1.yaw)};
      add([
        {x:p0.x-n0.x*halfWidth,z:p0.z-n0.z*halfWidth},
        {x:p0.x+n0.x*halfWidth,z:p0.z+n0.z*halfWidth},
        {x:p1.x+n1.x*halfWidth,z:p1.z+n1.z*halfWidth},
        {x:p1.x-n1.x*halfWidth,z:p1.z-n1.z*halfWidth}
      ]);
      // Include the complete turning body. A centreline ribbon alone omits bus
      // overhang at tight turns and can place visible wheels outside the curb.
      const sweep=[],dy=Math.atan2(Math.sin(p1.yaw-p0.yaw),Math.cos(p1.yaw-p0.yaw));
      for(let j=0;j<=4;j++){
        const t=j/4,pose={x:p0.x+(p1.x-p0.x)*t,z:p0.z+(p1.z-p0.z)*t,yaw:p0.yaw+dy*t};
        sweep.push(...vehicleFootprint(pose,vehicleLength,vehicleWidth,margin+curbMargin+.02));
      }
      add(sweep);
    }
  }
  for(const junction of junctions.values())polygons.push(curbMargin?junction.curbPolygon:junction.polygon);
  cached.variants.set(key,polygons);return polygons;
}

function coverageIndex(polygons){
  const stored=coverageCache.get(polygons);if(stored)return stored;
  const size=20,cells=new Map(),bounds=[];
  polygons.forEach((polygon,index)=>{
    const xs=polygon.map(p=>p.x),zs=polygon.map(p=>p.z),box={minX:Math.min(...xs),maxX:Math.max(...xs),minZ:Math.min(...zs),maxZ:Math.max(...zs)};bounds.push(box);
    for(let x=Math.floor(box.minX/size);x<=Math.floor(box.maxX/size);x++)for(let z=Math.floor(box.minZ/size);z<=Math.floor(box.maxZ/size);z++){const key=`${x}:${z}`;if(!cells.has(key))cells.set(key,[]);cells.get(key).push(index);}
  });
  const result={size,cells,bounds};coverageCache.set(polygons,result);return result;
}


