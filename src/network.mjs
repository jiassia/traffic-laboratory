import { emptyNetwork, parseDesign } from './simulation.mjs';
import { makePath,roadPath,roadPointAt,projectOnRoad,projectOnPath,pathLength,slicePath,sampleCircle } from './geometry.mjs';
import { normalizeTerminalRoads,terminalIds } from './terminals.mjs';
import {hasLaneConfiguration,laneCounts,roadWidth,copyLaneTurns} from './lanes.mjs';
import {roadEndTrim} from './junction-layout.mjs';

const EPS=1e-6,MIN_LENGTH=25,MIN_SPLIT=12,SNAP_DISTANCE=2;
const distance=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
const cross=(a,b)=>a.x*b.z-a.z*b.x;
const difference=(a,b)=>({x:a.x-b.x,z:a.z-b.z});
const copyNetwork=n=>normalizeTerminalRoads(parseDesign(JSON.stringify({network:n})).network);
const DEFAULT_SIGNAL={enabled:true,greenEW:20,greenNS:20,yellow:3,allRed:1,offset:0};
const FACILITY_TYPES=['streetlight','trafficLight','stopSign','speedSign'];
function checkedPoint(p){if(!p||typeof p.x!=='number'||typeof p.z!=='number'||!Number.isFinite(p.x)||!Number.isFinite(p.z)||Math.abs(p.x)>10000||Math.abs(p.z)>10000)throw new Error('绘制坐标无效');return{x:p.x,z:p.z};}
function allocator(ids,prefix){let next=1;for(const id of ids){const match=id.match(new RegExp(`^${prefix}_(\\d+)$`));if(match)next=Math.max(next,Number(match[1])+1);}return()=>{let id;do{id=`${prefix}_${next++}`;}while(ids.has(id));ids.add(id);return id;};}
function snapPoint(network,input){const p=checkedPoint(input);let nearest=null,best=SNAP_DISTANCE+EPS;for(const n of network.nodes){const d=distance(n,p);if(d<best){nearest={x:n.x,z:n.z};best=d;}}if(nearest)return nearest;for(const r of network.roads){const q=projectOnRoad(network,r,p);if(q.s>EPS&&q.s<roadPath(network,r).length-EPS&&q.distance<best){nearest={x:q.x,z:q.z};best=q.distance;}}return nearest||p;}
function attributes(options={}){
  const value={type:options.type??'local',speedLimit:options.speedLimit??50,oneWay:options.oneWay??false};if(options.shape!==undefined)value.shape=options.shape;if(options.width!==undefined)value.width=options.width;
  if(!['slow','local','main'].includes(value.type)||!Number.isFinite(value.speedLimit)||value.speedLimit<5||value.speedLimit>100||typeof value.oneWay!=='boolean')throw new Error('道路类型、限速或方向无效');
  if(value.shape!==undefined&&!['straight','curve','free','circle'].includes(value.shape))throw new Error('道路形状无效');
  if(hasLaneConfiguration(options)){value.lanesForward=options.lanesForward;value.lanesBackward=options.lanesBackward;laneCounts(value);value.width=roadWidth(value);}
  else if(value.width!==undefined&&(!Number.isFinite(value.width)||value.width<7||value.width>30))throw new Error('道路宽度应为 7 至 30 米');
  Object.assign(value,copyLaneTurns({...options,...value}));
  return value;
}

// Preserve a complete centreline per graph edge. Sample points do not become junctions.
function assemble(network,extraPaths=[],extraPoints=[],minimum=MIN_SPLIT){
  const nodes=network.nodes.map(n=>({...n})),nodeIds=new Set(nodes.map(n=>n.id)),roadIds=new Set(network.roads.map(r=>r.id)),nextNode=allocator(nodeIds,'n'),nextRoad=allocator(roadIds,'r');
  const ensureNode=p=>{let node=nodes.find(n=>distance(n,p)<EPS);if(!node){node={id:nextNode(),x:p.x,z:p.z};nodes.push(node);}return node;};
  const records=network.roads.map(road=>({road,path:roadPath(network,road),cuts:[0,roadPath(network,road).length],isNew:false}));
  for(const input of extraPaths){const path=makePath(input.points);records.push({road:null,path,cuts:[0,path.length],isNew:true,attributes:input.attributes});}
  for(const p of extraPoints)ensureNode(p);for(const record of records){ensureNode(record.path.points[0]);ensureNode(record.path.points.at(-1));}
  const grid=new Map(),CELL=40;
  const cells=s=>{const result=[];for(let x=Math.floor(Math.min(s.a.x,s.b.x)/CELL);x<=Math.floor(Math.max(s.a.x,s.b.x)/CELL);x++)for(let z=Math.floor(Math.min(s.a.z,s.b.z)/CELL);z<=Math.floor(Math.max(s.a.z,s.b.z)/CELL);z++)result.push(`${x}:${z}`);return result;};
  const insert=s=>{for(const key of cells(s)){if(!grid.has(key))grid.set(key,[]);grid.get(key).push(s);}};
  const compare=(a,b)=>{
    if(a.owner===b.owner&&Math.abs(a.index-b.index)<=1)return;const r=difference(a.b,a.a),s=difference(b.b,b.a),qp=difference(b.a,a.a),den=cross(r,s);
    if(Math.abs(den)<EPS){if(Math.abs(cross(qp,r))<EPS){const norm=r.x*r.x+r.z*r.z,t0=((b.a.x-a.a.x)*r.x+(b.a.z-a.a.z)*r.z)/norm,t1=((b.b.x-a.a.x)*r.x+(b.b.z-a.a.z)*r.z)/norm;const overlap=Math.min(1,Math.max(t0,t1))-Math.max(0,Math.min(t0,t1));if(overlap>EPS)throw new Error('道路重合，请从已有节点向空白区域绘制');}return;}
    const t=cross(qp,s)/den,u=cross(qp,r)/den;if(t>=-EPS&&t<=1+EPS&&u>=-EPS&&u<=1+EPS){const ta=Math.max(0,Math.min(1,t)),tb=Math.max(0,Math.min(1,u));records[a.owner].cuts.push(a.s+a.length*ta);records[b.owner].cuts.push(b.s+b.length*tb);ensureNode({x:a.a.x+r.x*ta,z:a.a.z+r.z*ta});}
  };
  for(let owner=0;owner<records.length;owner++)if(!records[owner].isNew)for(const segment of records[owner].path.segments)insert({...segment,owner});
  for(let owner=0;owner<records.length;owner++)if(records[owner].isNew)for(const segment of records[owner].path.segments){const current={...segment,owner},seen=new Set();for(const key of cells(current))for(const candidate of grid.get(key)||[]){const id=`${candidate.owner}:${candidate.index}`;if(!seen.has(id)){seen.add(id);compare(current,candidate);}}insert(current);}
  for(const record of records)for(const node of nodes){const q=projectOnPath(record.path,node);if(q.distance<EPS&&q.s>EPS&&q.s<record.path.length-EPS)record.cuts.push(q.s);}
  const roads=[],pairs=new Set(),children=new Map(),childRanges=new Map();
  for(const record of records){const cuts=record.cuts.sort((a,b)=>a-b).filter((s,i,list)=>!i||s-list[i-1]>EPS),resultIds=[];
    for(let i=1;i<cuts.length;i++){
      if((record.isNew||cuts.length>2)&&cuts[i]-cuts[i-1]<minimum-EPS)throw new Error(`交点附近的道路不足 ${minimum} 米，请拉开节点距离`);const points=slicePath(record.path,cuts[i-1],cuts[i]),a=ensureNode(points[0]),b=ensureNode(points.at(-1));if(a.id===b.id)throw new Error('闭合道路请使用圆形道路工具，或划分为多个路段');
      const pair=[a.id,b.id].sort().join('|');if(pairs.has(pair))throw new Error('两节点间已有道路');pairs.add(pair);const source=record.road??record.attributes,id=i===1&&record.road?record.road.id:nextRoad(),road={id,a:a.id,b:b.id,...attributes(source)};if(points.length>2||source.points)road.points=points;if(cuts[i]<record.path.length-EPS)delete road.turnsForward;if(cuts[i-1]>EPS)delete road.turnsBackward;roads.push(road);resultIds.push(id);if(record.road){if(!childRanges.has(record.road.id))childRanges.set(record.road.id,[]);childRanges.get(record.road.id).push({id,start:cuts[i-1],end:cuts[i]});}
    }if(record.road)children.set(record.road.id,resultIds);
  }
  const temp={nodes,roads},facilities=(network.facilities||[]).map(f=>{
    if(!f.roadId)return{...f};const candidates=roads.filter(r=>(children.get(f.roadId)||[f.roadId]).includes(r.id)&&(f.type!=='trafficLight'||r.a===f.nodeId||r.b===f.nodeId));
    let chosen=null;const range=(childRanges.get(f.roadId)||[]).find(part=>f.s>=part.start-EPS&&f.s<=part.end+EPS&&candidates.some(road=>road.id===part.id));if(range){const road=candidates.find(road=>road.id===range.id);chosen={road,q:{s:Math.max(0,Math.min(range.end-range.start,f.s-range.start)),distance:0}};}else for(const road of candidates){const q=projectOnRoad(temp,road,f);if(!chosen||q.distance<chosen.q.distance)chosen={road,q};}
    if(!chosen)return null;const heading=f.type==='trafficLight'?trafficApproach(temp,chosen.road,{id:f.nodeId}).heading:roadPointAt(temp,chosen.road,chosen.q.s).yaw;
    return{...f,roadId:chosen.road.id,s:chosen.q.s,heading};
  }).filter(Boolean);
  return copyNetwork({...network,nodes,roads,facilities});
}

export function addStroke(input,points){const network=copyNetwork(input);if(!Array.isArray(points)||points.length<2||points.length>512)throw new Error('道路需要 2 至 512 个绘制点');const normalized=points.map(p=>snapPoint(network,p)).filter((p,i,list)=>!i||distance(p,list[i-1])>EPS);if(normalized.length<2)throw new Error('道路需要两个不同的位置');const paths=[];for(let i=1;i<normalized.length;i++){const a=normalized[i-1],b=normalized[i];if(distance(a,b)<MIN_LENGTH-EPS)throw new Error('道路长度至少为 25 米');paths.push({points:[a,b],attributes:attributes()});}return assemble(network,paths,[],MIN_LENGTH);}
export function addRoadPath(input,points,options={}){const network=copyNetwork(input);if(!Array.isArray(points)||points.length<2||points.length>512)throw new Error('道路需要 2 至 512 个几何点');const normalized=points.map(checkedPoint);normalized[0]=snapPoint(network,normalized[0]);normalized[normalized.length-1]=snapPoint(network,normalized.at(-1));if(pathLength(normalized)<MIN_LENGTH-EPS)throw new Error('道路总长度至少为 25 米');if(distance(normalized[0],normalized.at(-1))<EPS)throw new Error('闭合道路请使用圆形道路工具');return assemble(network,[{points:normalized,attributes:attributes(options)}]);}
export function roundaboutMinRadius(options={}){return Math.max(20,roadWidth(attributes({...options,oneWay:options.oneWay??true,shape:'circle'}))/2+5);}
export function addRoundabout(input,center,radius,options={}){checkedPoint(center);const minimum=roundaboutMinRadius(options);if(!Number.isFinite(radius)||radius<minimum||radius>1000)throw new Error(`当前车道配置的圆形道路半径应为 ${minimum} 至 1000 米`);const network=copyNetwork(input),circle=sampleCircle(center,radius,64),opts=attributes({...options,oneWay:options.oneWay??true,shape:'circle'}),paths=[];for(let i=0;i<4;i++)paths.push({points:circle.slice(i*16,i*16+17),attributes:opts});return assemble(network,paths);}
export function placeEndpoint(input,kind,point){
  if(kind!=='source'&&kind!=='sink')throw new Error('端点类型无效');const network=copyNetwork(input),p=snapPoint(network,point),opposite=new Set(terminalIds(network,kind==='source'?'sink':'source')),label=kind==='source'?'入口':'出口';
  if(network.nodes.some(node=>opposite.has(node.id)&&distance(node,p)<EPS))throw new Error('入口和出口不能重合');
  const existing=network.nodes.find(n=>distance(n,p)<EPS);if(existing&&network.roads.filter(r=>r.a===existing.id||r.b===existing.id).length>1)throw new Error(`${label}只能放在道路端部，不能放在路口`);
  if(existing&&terminalIds(network,kind).includes(existing.id))return network;
  for(const road of network.roads){const q=projectOnRoad(network,road,p),length=roadPath(network,road).length;if(q.distance<EPS&&q.s>EPS&&q.s<length-EPS)throw new Error(`${label}不能放在道路中段，请选择道路端部`);}
  const next=assemble(network,[],[p],MIN_LENGTH),node=next.nodes.find(n=>distance(n,p)<EPS),ids=terminalIds(next,kind);if(!ids.includes(node.id))ids.push(node.id);
  next[kind==='source'?'sources':'sinks']=ids;next[kind]=ids[0]??null;return normalizeTerminalRoads(next);
}
export function removeEndpoint(input,kind,id){
  if(kind!=='source'&&kind!=='sink')throw new Error('端点类型无效');
  const network=copyNetwork(input),ids=terminalIds(network,kind).filter(value=>value!==id);
  network[kind==='source'?'sources':'sinks']=ids;network[kind]=ids[0]??null;
  return normalizeTerminalRoads(network);
}
export function removeAt(input,{roadId,nodeId}={}){const network=copyNetwork(input),removed=new Set();if(nodeId){for(const r of network.roads)if(r.a===nodeId||r.b===nodeId)removed.add(r.id);network.nodes=network.nodes.filter(n=>n.id!==nodeId);delete network.signals[nodeId];for(const kind of ['source','sink']){const ids=terminalIds(network,kind).filter(id=>id!==nodeId);network[kind==='source'?'sources':'sinks']=ids;network[kind]=ids[0]??null;}}if(roadId)removed.add(roadId);network.roads=network.roads.filter(r=>!removed.has(r.id));network.facilities=(network.facilities||[]).filter(f=>f.nodeId!==nodeId&&!removed.has(f.roadId));for(const id of Object.keys(network.signals))if(network.roads.filter(r=>r.a===id||r.b===id).length<2)delete network.signals[id];return normalizeTerminalRoads(network);}

export function demolitionSegment(network,roadId,s,length=32){
  const road=network?.roads?.find(r=>r.id===roadId);if(!road)throw new Error('未找到要拆除的道路');
  if(!Number.isFinite(s))throw new Error('拆除位置必须为有限数值');if(!Number.isFinite(length)||length<1)throw new Error('拆除长度至少为 1 米');
  const path=roadPath(network,road),roadLength=path.length,centerS=Math.max(0,Math.min(roadLength,s));
  let startS=Math.max(0,centerS-length/2),endS=Math.min(roadLength,centerS+length/2);
  // Short stubs cannot fit the existing vehicle/connector model, so the preview includes them.
  if(startS<MIN_SPLIT-EPS)startS=0;if(roadLength-endS<MIN_SPLIT-EPS)endS=roadLength;
  const points=slicePath(path,startS,endS),retained=[];
  if(startS>EPS)retained.push({startS:0,endS:startS,length:startS});if(endS<roadLength-EPS)retained.push({startS:endS,endS:roadLength,length:roadLength-endS});
  return {roadId,centerS,startS,endS,length:endS-startS,requestedLength:length,roadLength,wholeRoad:retained.length===0,points,startPoint:{...points[0]},endPoint:{...points.at(-1)},retained};
}

export function removeRoadSegment(input,{roadId,s,length=32}={}){
  const network=copyNetwork(input),range=demolitionSegment(network,roadId,s,length),road=network.roads.find(r=>r.id===roadId),path=roadPath(network,road);
  const nextNode=allocator(new Set(network.nodes.map(n=>n.id)),'n'),nextRoad=allocator(new Set(network.roads.map(r=>r.id)),'r');
  const ensureNode=point=>{let node=network.nodes.find(n=>distance(n,point)<EPS);if(!node){node={id:nextNode(),x:point.x,z:point.z};network.nodes.push(node);}return node;};
  const parts=range.retained.map((part,index)=>{
    const points=slicePath(path,part.startS,part.endS),a=part.startS<EPS?road.a:ensureNode(points[0]).id,b=part.endS>path.length-EPS?road.b:ensureNode(points.at(-1)).id;
    const piece={...road,id:index===0?road.id:nextRoad(),a,b};if(part.endS<path.length-EPS)delete piece.turnsForward;if(part.startS>EPS)delete piece.turnsBackward;if(road.points||points.length>2)piece.points=points;else delete piece.points;return {...part,road:piece};
  });
  network.roads=network.roads.flatMap(r=>r.id===roadId?parts.map(part=>part.road):[r]);
  network.facilities=(network.facilities||[]).map(f=>{
    if(f.roadId!==roadId)return f;
    if(f.s>=range.startS-EPS&&f.s<=range.endS+EPS)return null;
    if(f.type==='trafficLight'){
      const part=parts.find(p=>p.road.a===f.nodeId||p.road.b===f.nodeId);if(!part)return null;
      const approach=trafficApproach(network,part.road,{id:f.nodeId});if(!approach.legal)return null;
      const position=roadPointAt(network,part.road,approach.s,(roadWidth(part.road)/2+1.4)*f.side);
      return {...f,roadId:part.road.id,s:approach.s,x:position.x,z:position.z,heading:approach.heading};
    }
    const part=parts.find(p=>f.s>=p.startS-EPS&&f.s<=p.endS+EPS);if(!part)return null;const station=Math.max(0,Math.min(part.length,f.s-part.startS));
    return {...f,roadId:part.road.id,s:station,heading:roadPointAt(network,part.road,station).yaw};
  }).filter(Boolean);
  const removedControllers=new Set();for(const id of [road.a,road.b])if(network.signals[id]&&network.roads.filter(r=>r.a===id||r.b===id).length<2){delete network.signals[id];removedControllers.add(id);}
  network.facilities=network.facilities.filter(f=>f.type!=='trafficLight'||!removedControllers.has(f.nodeId));
  return copyNetwork(network);
}

function trafficApproach(network,road,node){
  const path=roadPath(network,road),forward=road.b===node.id,sign=forward?1:-1,trim=roadEndTrim(network,road,node.id),s=forward?path.length-trim:trim,center=roadPointAt(network,road,s);
  return {road,path,s,center,sign,legal:forward||!road.oneWay,heading:Math.atan2(Math.sin(center.yaw+(forward?0:Math.PI)),Math.cos(center.yaw+(forward?0:Math.PI)))};
}
export function realignTrafficLights(input){
  const network=copyNetwork(input),roads=new Map(network.roads.map(road=>[road.id,road]));
  network.facilities=network.facilities.map(f=>{
    if(f.type!=='trafficLight')return f;
    const road=roads.get(f.roadId);
    if(!road||!f.nodeId||(road.a!==f.nodeId&&road.b!==f.nodeId))throw new Error('信号灯绑定的道路来向无效，无法重新定位');
    const approach=trafficApproach(network,road,{id:f.nodeId}),position=roadPointAt(network,road,approach.s,(roadWidth(road)/2+1.4)*f.side);
    return {...f,s:approach.s,x:position.x,z:position.z,heading:approach.heading};
  });
  return network;
}
function approachDistance(network,approach,node,point){
  const q=projectOnRoad(network,approach.road,point),window=Math.min(30,approach.path.length),start=approach.road.a===node.id?0:approach.path.length-window,end=approach.road.a===node.id?window:approach.path.length,p=roadPointAt(network,approach.road,Math.max(start,Math.min(end,q.s)));
  return distance(p,point);
}
export function placeFacility(input,{type,point,side,roadId,nodeId}={}){
  if(!FACILITY_TYPES.includes(type))throw new Error('设施类型无效');const network=copyNetwork(input),p=checkedPoint(point);network.facilities??=[];const nextId=allocator(new Set(network.facilities.map(f=>f.id)),'f');let facility;
  if(type==='trafficLight'){
    const eligible=network.nodes.filter(n=>network.roads.filter(r=>r.a===n.id||r.b===n.id).length>=2).sort((a,b)=>distance(a,p)-distance(b,p)),node=nodeId?eligible.find(n=>n.id===nodeId):eligible[0];if(!node||distance(node,p)>45)throw new Error('请在道路交汇节点附近放置信号灯');
    const choices=network.roads.filter(r=>(r.a===node.id||r.b===node.id)&&(!roadId||r.id===roadId)).map(road=>trafficApproach(network,road,node)).sort((a,b)=>approachDistance(network,a,node,p)-approachDistance(network,b,node,p));
    const approach=choices[0];if(!approach)throw new Error('未找到信号灯绑定的道路来向');if(!approach.legal)throw new Error('所选道路为驶出方向，请在驶入路口的方向安装信号灯');
    const {road,s,center,sign,heading}=approach,dot=(p.x-center.x)*(-center.tangentZ)+(p.z-center.z)*center.tangentX,direction=side===-1?-1:side===1?1:Math.abs(dot)>.75?(dot<0?-1:1):sign;
    if(network.facilities.some(f=>f.type===type&&f.nodeId===node.id&&f.roadId===road.id&&f.side===direction))return network;
    const position=roadPointAt(network,road,s,(roadWidth(road)/2+1.4)*direction);facility={id:nextId(),type,x:position.x,z:position.z,roadId:road.id,nodeId:node.id,s,heading,side:direction};network.signals[node.id]={...DEFAULT_SIGNAL,...network.signals[node.id],enabled:true};
  }else{
    let nearest=null;for(const road of network.roads){if(roadId&&road.id!==roadId)continue;const q=projectOnRoad(network,road,p);if(!nearest||q.distance<nearest.q.distance)nearest={road,q};}if(!nearest||nearest.q.distance>35)throw new Error('请在道路附近放置设施');const {road,q}=nearest,length=roadPath(network,road).length,margin=2,s=Math.max(margin,Math.min(length-margin,q.s)),center=roadPointAt(network,road,s),dot=(p.x-center.x)*(-center.tangentZ)+(p.z-center.z)*center.tangentX,direction=side===-1?-1:side===1?1:dot<0?-1:1,offset=(roadWidth(road)/2+1.6)*direction,pos=roadPointAt(network,road,s,offset);
    if(network.facilities.some(f=>f.type===type&&f.roadId===road.id&&f.side===direction&&Math.abs(f.s-s)<4))return network;const toRoadX=center.x-pos.x,toRoadZ=center.z-pos.z,streetHeading=Math.hypot(toRoadX,toRoadZ)>0.01?Math.atan2(-toRoadZ,toRoadX):pos.yaw;facility={id:nextId(),type,x:pos.x,z:pos.z,roadId:road.id,nodeId:null,s,heading:type==='streetlight'?streetHeading:pos.yaw,side:direction};
  }network.facilities.push(facility);return copyNetwork(network);
}
export function removeFacility(input,id){const network=copyNetwork(input),facility=(network.facilities||[]).find(f=>f.id===id);network.facilities=(network.facilities||[]).filter(f=>f.id!==id);if(facility?.type==='trafficLight'&&!network.facilities.some(f=>f.type==='trafficLight'&&f.nodeId===facility.nodeId))delete network.signals[facility.nodeId];return network;}
export function autoPlaceFacilities(input,{streetlights=true,trafficLights=false,spacing=30}={}){
  if(!Number.isFinite(spacing)||spacing<15||spacing>100)throw new Error('自动布置间距应为 15 至 100 米');let network=copyNetwork(input);const sourceRoads=[...network.roads];
  if(streetlights)for(const road of sourceRoads){const length=roadPath(network,road).length;for(let s=Math.min(12,length/2);s<length-5;s+=spacing)for(const side of[-1,1])network=placeFacility(network,{type:'streetlight',point:roadPointAt(network,road,s,roadWidth(road)/2*side),side,roadId:road.id});}
  if(trafficLights)for(const node of [...network.nodes])if(network.roads.filter(r=>r.a===node.id||r.b===node.id).length>=3)for(const road of network.roads.filter(r=>r.a===node.id||r.b===node.id)){
    const approach=trafficApproach(network,road,node);if(!approach.legal)continue;network=placeFacility(network,{type:'trafficLight',point:approach.center,roadId:road.id,nodeId:node.id,side:approach.sign});
  }
  return network;
}

export function createPreset(name='fork'){
  if(!['fork','signal','bottleneck','roundabout','accident'].includes(name))throw new Error('未找到此路网预设');
  if(name==='roundabout'){let n=addRoundabout(emptyNetwork(),{x:0,z:0},36,{speedLimit:30,type:'slow'});n=addRoadPath(n,[{x:-126,z:0},{x:-36,z:0}],{shape:'straight'});n=addRoadPath(n,[{x:36,z:0},{x:126,z:0}],{shape:'straight'});n.source=n.nodes.find(p=>Math.abs(p.x+126)<EPS&&Math.abs(p.z)<EPS).id;n.sink=n.nodes.find(p=>Math.abs(p.x-126)<EPS&&Math.abs(p.z)<EPS).id;return autoPlaceFacilities(n,{streetlights:true,spacing:30});}
  const n=emptyNetwork();n.nodes=[{id:'n_1',x:-120,z:0},{id:'n_2',x:-60,z:0},{id:'n_3',x:0,z:0},{id:'n_4',x:60,z:0},{id:'n_5',x:120,z:0}];const edge=(a,b,type='local',speedLimit=50)=>n.roads.push({id:`r_${n.roads.length+1}`,a,b,type,speedLimit,oneWay:false});edge('n_1','n_2');edge('n_2','n_3');edge('n_3','n_4',name==='bottleneck'?'slow':'local',name==='bottleneck'?30:50);edge('n_4','n_5');
  if(name==='fork'){n.nodes.push({id:'n_6',x:-60,z:-60},{id:'n_7',x:0,z:-60},{id:'n_8',x:60,z:-60});edge('n_2','n_6');edge('n_6','n_7');edge('n_7','n_8');edge('n_8','n_4');}
  if(['signal','accident'].includes(name)){n.nodes.push({id:'n_6',x:0,z:-60},{id:'n_7',x:60,z:-60},{id:'n_8',x:0,z:60});edge('n_3','n_6');edge('n_6','n_7');edge('n_7','n_4');edge('n_3','n_8');n.signals.n_3={...DEFAULT_SIGNAL};}
  n.source='n_1';n.sink='n_5';if(name==='accident')return autoPlaceFacilities(n,{streetlights:true,trafficLights:true,spacing:30});return normalizeTerminalRoads(n);
}
