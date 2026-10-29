import {roadPath,slicePath,pathPointAt} from './geometry.mjs';
import {laneCounts,roadWidth} from './lanes.mjs';
import {convexJunctionPolygon as localHull} from './junction-layout.mjs';
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
export function pavementFootprints(network,connections=EMPTY_CONNECTIONS,{vehicleLength=10.923,vehicleWidth=3.0224,margin=.65,curbMargin=0}={}){
  if(!finite(vehicleLength)||vehicleLength<=0||!finite(vehicleWidth)||vehicleWidth<=0||!finite(margin)||margin<0||!finite(curbMargin)||curbMargin<0)throw new Error('路面扫掠尺寸必须为有效非负数，车辆尺寸应大于零');
  const key=`${vehicleLength}:${vehicleWidth}:${margin}:${curbMargin}`;
  let cached=footprintCache.get(network);const ports=JSON.stringify([terminalIds(network,'source'),terminalIds(network,'sink')]);
  if(!cached||cached.roads!==network.roads||cached.nodes!==network.nodes||cached.ports!==ports||cached.connections!==connections){cached={roads:network.roads,nodes:network.nodes,ports,connections,variants:new Map()};footprintCache.set(network,cached);}
  if(cached.variants.has(key))return cached.variants.get(key);
  const roadPieces=[];
  const addRoad=(points,width)=>{const polygon=localHull(points);if(polygon.length>=3)roadPieces.push({polygon,width});};
  for(const road of network.roads){
    const path=roadPath(network,road),half=roadWidth(road)/2+curbMargin;
    for(let i=1;i<path.distances.length;i++){
      const start=path.distances[i-1],end=path.distances[i];
      addRoad([pathPointAt(path,start,-half),pathPointAt(path,start,half),pathPointAt(path,end,-half),pathPointAt(path,end,half)],half*2);
    }
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
    }
  }
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
