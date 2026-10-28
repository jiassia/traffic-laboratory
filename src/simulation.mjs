// Deterministic, metre-second teaching traffic model. Rendering never advances this state.
import {roadPath,pathPointAt,makePath,projectOnPath} from './geometry.mjs';
import {roadEndTrim,junctionIssues} from './junction-layout.mjs';
import {createTrafficEngine} from './trafficEngine.mjs';
import {normalizeTerminalRoads,terminalIds,isSource,isSink} from './terminals.mjs';
import {VEHICLE_PROFILES} from './vehicle-profiles.mjs';
import {laneCounts,laneOffset,laneKey,roadWidth,hasLaneConfiguration,copyLaneTurns,LANE_WIDTH,classifyTurn,laneAllowsMovement} from './lanes.mjs';
export const MODEL_VERSION = 'traffic-si-7';
export const FIXED_STEP = 0.05;
export const LANE_OFFSET = 2;
export const JUNCTION_TRIM = 8;
const MAX_ACTIVE = 64;
const MIN_GAP = 2;
const clone = value => JSON.parse(JSON.stringify(value));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const finite = (x, a, b) => typeof x === 'number' && Number.isFinite(x) && x >= a && x <= b;
export const VEHICLE_TYPES = Object.freeze([
  { id:'sedan', name:'轿车', length:4.773, width:2.234, height:1.47, color:'#e6e9e9' },
  { id:'hatchback', name:'两厢车', length:4.193, width:2.1888, height:1.5225, color:'#b6d4cc' },
  { id:'suv', name:'SUV', length:4.983, width:2.4374, height:1.935, color:'#3d83b5' },
  { id:'taxi', name:'出租车', length:4.783, width:2.2453, height:1.79, color:'#ffc14a' },
  { id:'pickup', name:'皮卡', length:5.523, width:2.4826, height:1.91, color:'#b64f44' },
  { id:'van', name:'厢式车', length:5.623, width:2.5139, height:2.56, color:'#d5d6d4' },
  { id:'truck', name:'卡车', length:7.123, width:2.7964, height:3.32, color:'#cf7251' },
  { id:'bus', name:'公交', length:10.923, width:3.0224, height:3.32, color:'#6e9a8c' },
].map(type=>({...type,...VEHICLE_PROFILES[type.id]})));
const TYPES = Object.fromEntries(VEHICLE_TYPES.map(v => [v.id, v]));
const VIOLATIONS = ['speeding','hesitation','parking','priority'];
export function defaultSettings() { return { demand:12, knownExit:true, breakdown:0, violation:0, violations:[...VIOLATIONS], speeds:Object.fromEntries(VEHICLE_TYPES.map(v => [v.id,v.maxSpeed])), seed:20261028,compliance:100,signalMode:'normal',weather:'clear',reactionTime:1,accidentsEnabled:true,incidentDuration:60,timeOfDay:'day' }; }
export function emptyNetwork() { return { version:1, nodes:[], roads:[], source:null, sink:null, signals:{},facilities:[] }; }

function checkedSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('驾驶设置格式无效');
  const d=defaultSettings(), result={...d,...input,speeds:{...d.speeds,...input.speeds}};
  if (!finite(result.demand,0,120)) throw new Error('进车量应为每分钟 0 至 120 辆');
  if (typeof result.knownExit!=='boolean') throw new Error('导航设置应为开关值');
  if (!finite(result.breakdown,0,100)||!finite(result.violation,0,100)) throw new Error('事件概率应为 0 至 100');
  if (!Number.isInteger(result.seed)||!finite(result.seed,0,4294967295)) throw new Error('随机种子应为有效非负整数');
  if (!Array.isArray(result.violations)||result.violations.length>4||new Set(result.violations).size!==result.violations.length||result.violations.some(x=>!VIOLATIONS.includes(x))) throw new Error('违规类型无效');
  for (const t of VEHICLE_TYPES) if (!finite(result.speeds[t.id],5,140)) throw new Error(`${t.name}期望速度应为 5 至 140 km/h`);
  for(const field of ['compliance'])if(!finite(result[field],0,100))throw new Error(`${field} 应为 0 至 100 的百分比`);
  if(!['normal','green','red','off'].includes(result.signalMode))throw new Error('信号覆盖模式无效');
  if(!['clear','rain','fog','snow'].includes(result.weather))throw new Error('天气类型无效');
  if(!['day','night'].includes(result.timeOfDay))throw new Error('昼夜设置无效');
  if(!finite(result.reactionTime,.3,3)||!finite(result.incidentDuration,10,600)||typeof result.accidentsEnabled!=='boolean')throw new Error('反应时间或事故设置无效');
  return {demand:result.demand,knownExit:result.knownExit,breakdown:result.breakdown,violation:result.violation,violations:[...result.violations],speeds:Object.fromEntries(VEHICLE_TYPES.map(t=>[t.id,result.speeds[t.id]])),seed:result.seed,compliance:result.compliance,signalMode:result.signalMode,weather:result.weather,reactionTime:result.reactionTime,accidentsEnabled:result.accidentsEnabled,incidentDuration:result.incidentDuration,timeOfDay:result.timeOfDay};
}
function checkedSignal(value) {
  if (!value || typeof value!=='object' || typeof value.enabled!=='boolean') throw new Error('信号设置格式无效');
  const s={enabled:value.enabled,greenEW:value.greenEW,greenNS:value.greenNS,yellow:value.yellow,allRed:value.allRed,offset:value.offset??0};
  if (!finite(s.greenEW,1,120)||!finite(s.greenNS,1,120)||!finite(s.yellow,1,10)||!finite(s.allRed,.5,10)||!finite(s.offset,0,3600)) throw new Error('信号时长超出允许范围');
  return s;
}
function checkedNetwork(value) {
  if (!value||value.version!==1) throw new Error('不支持此路网版本');
  if (!Array.isArray(value.nodes)||!Array.isArray(value.roads)||value.nodes.length>256||value.roads.length>512) throw new Error('路网数量或格式无效');
  const ids=new Set(), roadIds=new Set(), pairs=new Set();
  const validId=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(x);
  const nodes=value.nodes.map(n=>{
    if (!n||!validId(n.id)||ids.has(n.id)||!finite(n.x,-10000,10000)||!finite(n.z,-10000,10000)) throw new Error('节点编号重复或坐标无效');
    ids.add(n.id); return {id:n.id,x:n.x,z:n.z};
  });
  const byId=Object.fromEntries(nodes.map(n=>[n.id,n]));
  const roads=value.roads.map(r=>{
    if (!r||!validId(r.id)||roadIds.has(r.id)||!ids.has(r.a)||!ids.has(r.b)||r.a===r.b) throw new Error('道路编号或连接节点无效');
    if (!['slow','local','main'].includes(r.type)||!finite(r.speedLimit,5,100)||(r.oneWay!==undefined&&typeof r.oneWay!=='boolean')) throw new Error('道路类型或限速无效');
    const pair=[r.a,r.b].sort().join('|');
    if (pairs.has(pair)) throw new Error('两节点间存在重复道路');
    const result={id:r.id,a:r.a,b:r.b,type:r.type,speedLimit:r.speedLimit,oneWay:r.oneWay??false};
    if(r.points!==undefined){if(!Array.isArray(r.points)||r.points.length<2||r.points.length>2048)throw new Error('道路中心线采样无效');result.points=r.points.map(p=>{if(!p||!finite(p.x,-10000,10000)||!finite(p.z,-10000,10000))throw new Error('道路中心线坐标无效');return{x:p.x,z:p.z};});if(Math.hypot(result.points[0].x-byId[r.a].x,result.points[0].z-byId[r.a].z)>.05||Math.hypot(result.points.at(-1).x-byId[r.b].x,result.points.at(-1).z-byId[r.b].z)>.05)throw new Error('道路中心线与连接节点不吻合');}
    if(r.shape!==undefined){if(!['straight','curve','free','circle'].includes(r.shape))throw new Error('道路形状无效');result.shape=r.shape;}
    if(hasLaneConfiguration(r)){result.lanesForward=r.lanesForward;result.lanesBackward=r.lanesBackward;laneCounts(result);result.width=roadWidth(result);}else if(r.width!==undefined){if(!finite(r.width,6,60))throw new Error('道路宽度应为 6 至 60 米');result.width=r.width;}
    Object.assign(result,copyLaneTurns({...r,...result}));
    const length=roadPath({nodes,roads:[]},result).length;
    if (length<12-1e-8) throw new Error('道路长度至少为 12 米');
    if (length>3000) throw new Error('单段道路过长');
    roadIds.add(r.id);pairs.add(pair);return result;
  });
  for (const k of ['source','sink']) {
    if(value[k]!=null&&!ids.has(value[k]))throw new Error('入口或出口引用无效');
    const plural=value[`${k}s`];if(plural!==undefined&&(!Array.isArray(plural)||plural.length>256||plural.some(id=>!ids.has(id))))throw new Error('入口或出口列表引用无效');
  }
  const sources=terminalIds(value,'source'),sinks=terminalIds(value,'sink');
  if(sources.some(id=>sinks.includes(id)))throw new Error('入口和出口不能重合');
  if (!value.signals||typeof value.signals!=='object'||Array.isArray(value.signals)) throw new Error('路口信号格式无效');
  const signals={};
  for(const [id,s] of Object.entries(value.signals)) { if(!ids.has(id))throw new Error('信号引用的节点不存在'); signals[id]=checkedSignal(s); }
  if(value.facilities!==undefined&&(!Array.isArray(value.facilities)||value.facilities.length>2048))throw new Error('设施列表过大或格式无效');
  const facilityIds=new Set();
  const facilities=(value.facilities||[]).filter(f=>f?.type!=='crosswalk').map(f=>{if(!f||!validId(f.id)||facilityIds.has(f.id)||!['streetlight','trafficLight','stopSign','speedSign'].includes(f.type)||!finite(f.x,-10000,10000)||!finite(f.z,-10000,10000))throw new Error('设施编号、类型或坐标无效');facilityIds.add(f.id);if(f.roadId!=null&&!roadIds.has(f.roadId))throw new Error('设施引用的道路不存在');if(f.nodeId!=null&&!ids.has(f.nodeId))throw new Error('设施引用的节点不存在');if(f.s!==undefined&&!finite(f.s,0,3000))throw new Error('设施道路里程无效');if(f.heading!==undefined&&!finite(f.heading,-Math.PI*4,Math.PI*4))throw new Error('设施朝向无效');if(f.side!==undefined&&![-1,1].includes(f.side))throw new Error('设施侧向无效');return{id:f.id,type:f.type,x:f.x,z:f.z,roadId:f.roadId??null,nodeId:f.nodeId??null,s:f.s??0,heading:f.heading??0,side:f.side??1};});
  return normalizeTerminalRoads({version:1,nodes,roads,source:value.source??null,sink:value.sink??null,sources,sinks,signals,facilities});
}
function outgoing(network,id) { return network.roads.flatMap(r=>r.a===id?[{road:r,from:r.a,to:r.b}]:r.b===id&&!r.oneWay?[{road:r,from:r.b,to:r.a}]:[]).sort((a,b)=>a.road.id.localeCompare(b.road.id)); }
export function validateNetwork(network) {
  try {
    const n=checkedNetwork(network);
    const sources=terminalIds(n,'source'),sinks=terminalIds(n,'sink');
    if (!sources.length) return {valid:false,reason:'先放置至少一个入口'};
    if (!sinks.length) return {valid:false,reason:'连接道路后放置至少一个出口'};
    for(const id of sources)if(n.roads.filter(road=>road.a===id||road.b===id).length!==1)return {valid:false,reason:`入口 ${id} 必须连接一条驶入路网的单向道路`};
    for(const id of sinks)if(n.roads.filter(road=>road.a===id||road.b===id).length!==1)return {valid:false,reason:`出口 ${id} 必须连接一条驶离路网的单向道路`};
    const geometryIssue=junctionIssues(n)[0];if(geometryIssue)return {valid:false,reason:geometryIssue.message,geometryIssue};
    const reachedSinks=new Set();
    for(const source of sources){const visited=new Set([source]),q=[source];while(q.length)for(const edge of outgoing(n,q.shift()))if(!visited.has(edge.to)){visited.add(edge.to);q.push(edge.to);}const reachable=sinks.filter(id=>visited.has(id));if(!reachable.length)return {valid:false,reason:`入口 ${source} 与出口尚未连通，请检查道路方向`};for(const id of reachable)reachedSinks.add(id);}
    const unreachable=sinks.find(id=>!reachedSinks.has(id));return unreachable?{valid:false,reason:`出口 ${unreachable} 无法从任何入口到达，请检查道路方向`}:{valid:true,reason:'所有入口和出口均已接通'};
  } catch(error) { return {valid:false,reason:error.message}; }
}
export function parseDesign(text) {
  if (typeof text!=='string'||text.length>1000000) throw new Error('设计文件过大，最多支持 1 MB');
  let data;try{data=JSON.parse(text);}catch{throw new Error('文件不是有效的 JSON 设计');}
  if (!data||typeof data!=='object'||(data.version!==undefined&&data.version!==1)) throw new Error('不支持此设计版本');
  return {network:checkedNetwork(data.network??data),settings:checkedSettings(data.settings??{})};
}
export function signalPhase(signal,time,mode='normal') {
  if(signal?.enabled&&mode==='red')return {ew:'red',ns:'red'};
  if(signal?.enabled&&(mode==='green'||mode==='off'))return {ew:'green',ns:'green'};
  if (!signal?.enabled) return {ew:'green',ns:'green'};
  const a=signal.greenEW,b=signal.greenNS,y=signal.yellow,r=signal.allRed,cycle=a+b+2*y+2*r;
  if (!Number.isFinite(cycle)||cycle<=0||!Number.isFinite(time)) return {ew:'red',ns:'red'};
  const t=((time+(signal.offset??0))%cycle+cycle)%cycle;
  if(t<a)return {ew:'green',ns:'red'};
  if(t<a+y)return {ew:'yellow',ns:'red'};
  if(t<a+y+r)return {ew:'red',ns:'red'};
  if(t<a+y+r+b)return {ew:'red',ns:'green'};
  if(t<a+2*y+r+b)return {ew:'red',ns:'yellow'};
  return {ew:'red',ns:'red'};
}
function makeLane(network,road,from,index=0) {
  const to=road.a===from?road.b:road.a, a=network.nodes.find(n=>n.id===from),b=network.nodes.find(n=>n.id===to);
  const centerPath=roadPath(network,road),forward=road.a===from,signedOffset=laneOffset(road,forward,index),offset=Math.abs(signedOffset);
  const path=makePath(centerPath.distances.map(s=>pathPointAt(centerPath,s,signedOffset))),length=path.length;
  const start=pathPointAt(path,forward?0:length),yaw=start.yaw+(forward?0:Math.PI),dx=Math.sin(yaw),dz=Math.cos(yaw);
  const centerTrim=nodeId=>{const deadEnd=network.roads.filter(r=>r.a===nodeId||r.b===nodeId).length===1&&!road.oneWay&&!isSource(network,nodeId)&&!isSink(network,nodeId);return deadEnd?Math.min(JUNCTION_TRIM,centerPath.length*.25):roadEndTrim(network,road,nodeId);};
  const atFrom=centerTrim(from),atTo=centerTrim(to),cutStart=pathPointAt(centerPath,forward?atFrom:centerPath.length-atFrom,signedOffset),cutEnd=pathPointAt(centerPath,forward?centerPath.length-atTo:atTo,signedOffset);
  const startS=projectOnPath(path,cutStart).s,endS=projectOnPath(path,cutEnd).s,trimStart=forward?startS:length-startS,trimEnd=forward?length-endS:endS;
  return {key:laneKey(road,from,index),road,from,to,a,b,path,centerPath,forward,index,signedOffset,length,dx,dz,trim:trimEnd,trimStart,trimEnd,offset};
}
function point(lane,s) {const clamped=clamp(s,0,lane.length),p=pathPointAt(lane.path,lane.forward?clamped:lane.length-clamped),yaw=p.yaw+(lane.forward?0:Math.PI),extra=s-clamped;return{x:p.x+Math.sin(yaw)*extra,z:p.z+Math.cos(yaw)*extra,yaw,curvature:(p.curvature||0)*(lane.forward?1:-1)};}
export function lanePoint(network,road,fromNodeId,s,index=0) {const {x,z,yaw}=point(makeLane(network,road,fromNodeId,index),s);return{x,z,yaw:Math.atan2(Math.sin(yaw),Math.cos(yaw))};}
function connector(inLane,outLane) {
  const p0=point(inLane,inLane.length-inLane.trim),p3=point(outLane,outLane.trimStart),inDir={x:Math.sin(p0.yaw),z:Math.cos(p0.yaw)},outDir={x:Math.sin(p3.yaw),z:Math.cos(p3.yaw)};
  const dot=inDir.x*outDir.x+inDir.z*outDir.z;
  const base=Math.min(inLane.trimEnd,outLane.trimStart),delta={x:p3.x-p0.x,z:p3.z-p0.z},available=Math.max(.25,Math.min(delta.x*inDir.x+delta.z*inDir.z,delta.x*outDir.x+delta.z*outDir.z));
  const k=dot<-.9?base*2:dot<.7?Math.min(base*.85,available*.55228475):base*.85;
  const p1={x:p0.x+inDir.x*k,z:p0.z+inDir.z*k},p2={x:p3.x-outDir.x*k,z:p3.z-outDir.z*k};
  let last=p0,length=0; const points=[];
  for(let i=0;i<=48;i++) {
    const t=i/48,u=1-t, x=u*u*u*p0.x+3*u*u*t*p1.x+3*u*t*t*p2.x+t*t*t*p3.x,z=u*u*u*p0.z+3*u*u*t*p1.z+3*u*t*t*p2.z+t*t*t*p3.z;
    const dx=3*u*u*(p1.x-p0.x)+6*u*t*(p2.x-p1.x)+3*t*t*(p3.x-p2.x),dz=3*u*u*(p1.z-p0.z)+6*u*t*(p2.z-p1.z)+3*t*t*(p3.z-p2.z);
    length+=Math.hypot(x-last.x,z-last.z);points.push({x,z,s:length,yaw:Math.atan2(dx,dz)});last={x,z};
  }
  return {points,length,outLane,junction:inLane.to};
}
function curvePoint(turn,s) {
  const p=turn.points;let i=1;while(i<p.length-1&&p[i].s<s)i++;
  const a=p[i-1],b=p[i],t=clamp((s-a.s)/(b.s-a.s||1),0,1),dy=Math.atan2(Math.sin(b.yaw-a.yaw),Math.cos(b.yaw-a.yaw));
  return {x:a.x+(b.x-a.x)*t,z:a.z+(b.z-a.z)*t,yaw:a.yaw+dy*t};
}
function random(seed,id,stream=0) {let n=(seed^Math.imul(id+1,0x9e3779b1)^Math.imul(stream+1,0x85ebca6b))>>>0;n^=n>>>16;n=Math.imul(n,0x7feb352d);n^=n>>>15;n=Math.imul(n,0x846ca68b);n^=n>>>16;return(n>>>0)/4294967296;}
function shortestPath(network,from,target) {
  const dist=new Map([[from,0]]),prev=new Map(),todo=new Set(network.nodes.map(n=>n.id));
  while(todo.size) {
    let at=null,best=Infinity;for(const id of [...todo].sort()) if((dist.get(id)??Infinity)<best){at=id;best=dist.get(id);}
    if(at===null)break;todo.delete(at);if(at===target)break;
    for(const edge of outgoing(network,at)) { const cost=makeLane(network,edge.road,at).length,next=best+cost;if(next<(dist.get(edge.to)??Infinity)-1e-8){dist.set(edge.to,next);prev.set(edge.to,{...edge});} }
  }
  if(!dist.has(target))return[];const edges=[];let at=target;
  while(at!==from){const e=prev.get(at);if(!e)return[];edges.unshift(e);at=e.from;}return edges;
}

export function createSimulation(inputNetwork,inputSettings=defaultSettings()) {
  return createTrafficEngine(inputNetwork,inputSettings,{checkedNetwork,checkedSettings,validateNetwork,makeLane,point,connector,curvePoint,random,shortestPath,signalPhase,VEHICLE_TYPES,FIXED_STEP,MODEL_VERSION,MAX_ACTIVE,MIN_GAP});
}

const junctionConnectionCache=new WeakMap();
/** Pure renderer geometry from the exact lane paths and connector function used by the engine. */
export function junctionConnections(inputNetwork){
  const cached=junctionConnectionCache.get(inputNetwork);if(cached&&cached.roads===inputNetwork.roads&&cached.nodes===inputNetwork.nodes)return cached.connections;
  const network=checkedNetwork(inputNetwork),lanes=new Map(),connections=[];
  const lane=(road,from,index)=>{const key=laneKey(road,from,index);if(!lanes.has(key))lanes.set(key,makeLane(network,road,from,index));return lanes.get(key);};
  for(const node of network.nodes){
    const attached=network.roads.filter(road=>road.a===node.id||road.b===node.id),outs=outgoing(network,node.id);
    const incoming=attached.flatMap(road=>road.b===node.id?[{road,from:road.a,forward:true}]:!road.oneWay?[{road,from:road.b,forward:false}]:[]);
    for(const entry of incoming){
      const inCount=entry.forward?laneCounts(entry.road).forward:laneCounts(entry.road).backward;
      for(const exit of outs){
        const uTurn=entry.road.id===exit.road.id;
        const outForward=exit.from===exit.road.a,outCount=outForward?laneCounts(exit.road).forward:laneCounts(exit.road).backward,turn=classifyTurn(network,entry.road,entry.forward,exit.road,outForward);
        for(let i=0;i<inCount;i++){
          if(!laneAllowsMovement(network,entry.road,entry.forward,i,exit.road,outForward))continue;
          const preferred=turn==='left'?0:turn==='right'?outCount-1:inCount===1?Math.floor((outCount-1)/2):Math.round(i/(inCount-1)*(outCount-1));
          for(let j=0;j<outCount;j++){
            const inLane=lane(entry.road,entry.from,i),outLane=lane(exit.road,exit.from,j),path=connector(inLane,outLane);
            connections.push({nodeId:node.id,inRoadId:entry.road.id,outRoadId:exit.road.id,inFrom:entry.from,outFrom:exit.from,inForward:entry.forward,outForward,inLaneIndex:i,outLaneIndex:j,inLaneId:inLane.key,outLaneId:outLane.key,turn,uTurn,preferred:j===preferred,laneWidth:LANE_WIDTH,points:path.points.map(p=>({...p})),length:path.length});
          }
        }
      }
    }
  }
  junctionConnectionCache.set(inputNetwork,{roads:inputNetwork.roads,nodes:inputNetwork.nodes,connections});return connections;
}
