import { makePath,pathPointAt } from './geometry.mjs';
import {hasLaneConfiguration,laneCounts,roadWidth} from './lanes.mjs';

const EPS=1e-6;
const angle=value=>Math.atan2(Math.sin(value),Math.cos(value));
const plural=kind=>kind==='source'?'sources':kind==='sink'?'sinks':null;
export function terminalIds(network,kind){
  const key=plural(kind);if(!key)throw new Error('端口类型无效');
  const list=network?.[key]??[];if(!Array.isArray(list))throw new Error(kind==='source'?'入口列表格式无效':'出口列表格式无效');
  const ids=[...list];if(network?.[kind]!=null)ids.push(network[kind]);
  if(ids.some(id=>typeof id!=='string'||!id.length))throw new Error('端口列表包含无效节点编号');
  return [...new Set(ids)];
}
export const isSource=(network,id)=>terminalIds(network,'source').includes(id);
export const isSink=(network,id)=>terminalIds(network,'sink').includes(id);
export function terminalLabel(network,kind,id){
  const ids=terminalIds(network,kind),label=kind==='source'?'入口':'出口',index=ids.indexOf(id);
  return ids.length>1&&index>=0?`${label} ${index+1}`:label;
}

// Mutates the network container and returns it. Road replacements invalidate cached paths.
// An isolated terminal remains a valid editing state; a connected terminal has one directed road.
export function normalizeTerminalRoads(network){
  if(!network||!Array.isArray(network.nodes)||!Array.isArray(network.roads))throw new Error('路网格式无效');
  const sources=terminalIds(network,'source'),sinks=terminalIds(network,'sink');
  if(sources.some(id=>sinks.includes(id)))throw new Error('入口和出口不能重合');
  const nodes=new Map(network.nodes.map(node=>[node.id,node])),plans=new Map();
  for(const [kind,label] of [['source','入口'],['sink','出口']]){
    for(const id of kind==='source'?sources:sinks){
    if(!nodes.has(id))throw new Error(`${label}节点不存在`);
    const roads=network.roads.filter(road=>road.a===id||road.b===id);
    if(roads.length>1)throw new Error(`${label}只能连接一条道路，请在其他节点分岔`);
    if(!roads.length)continue;const road=roads[0],reverse=kind==='source'?road.a!==id:road.b!==id;
    const previous=plans.get(road);if(previous&&previous.reverse!==reverse)throw new Error(previous.kind===kind?`同一条道路不能连接两个${label}`:'入口与出口的道路方向冲突');
    plans.set(road,{reverse,kind});
    }
  }
  const replacements=new Map(),reversed=new Map();
  for(const [road,plan] of plans){
    const explicit=hasLaneConfiguration(road),counts=explicit?laneCounts(road):null,terminalRoad={...road,oneWay:true};
    // Turning rules belong to the approached endpoint. Combining directions or reversing
    // a one-way port changes that endpoint or its lane population, so use topology again.
    if(!road.oneWay||plan.reverse){delete terminalRoad.turnsForward;delete terminalRoad.turnsBackward;}else delete terminalRoad.turnsBackward;
    // A terminal has no counterflow: retain the physical lane total in its permitted direction.
    if(explicit){terminalRoad.lanesForward=counts.total;terminalRoad.lanesBackward=0;terminalRoad.width=roadWidth(terminalRoad);}
    if(!plan.reverse){if(!road.oneWay||explicit)replacements.set(road,terminalRoad);continue;}
    const a=nodes.get(road.a),b=nodes.get(road.b);if(!a||!b)throw new Error('道路端点不存在');
    const path=makePath(road.points?.length>=2?road.points:[a,b]),replacement={...terminalRoad,a:road.b,b:road.a};
    if(road.points)replacement.points=[...road.points].reverse().map(point=>({...point}));
    replacements.set(road,replacement);reversed.set(road.id,{path,length:path.length,road});
  }
  const facilities=Array.isArray(network.facilities)?network.facilities.map(f=>{
    const item=reversed.get(f.roadId);if(!item)return f;
    const station=f.s??0;if(!Number.isFinite(station)||station<-EPS||station>item.length+EPS)throw new Error('设施位置超出道路长度，无法调整端口方向');
    const originalHeading=Number.isFinite(f.heading)?f.heading:pathPointAt(item.path,station).yaw;
    // Traffic-light headings describe the physical incoming approach, which does not rotate
    // when the same road centreline is stored in reverse. Other headings follow road forward.
    const heading=f.type==='trafficLight'?originalHeading:angle(originalHeading+Math.PI);
    return {...f,s:Math.max(0,Math.min(item.length,item.length-station)),side:-(f.side??1),heading};
  }):network.facilities;
  if(replacements.size)network.roads=network.roads.map(road=>replacements.get(road)||road);
  if(Array.isArray(facilities))network.facilities=facilities;
  network.sources=sources;network.sinks=sinks;network.source=sources[0]??null;network.sink=sinks[0]??null;
  return network;
}
