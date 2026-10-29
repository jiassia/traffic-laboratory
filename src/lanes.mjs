import {roadPath,pathPointAt} from './geometry.mjs';
export const LANE_WIDTH=3.6;
export const ROAD_SHOULDERS=2.4;
export const hasLaneConfiguration=road=>road.lanesForward!==undefined||road.lanesBackward!==undefined;

export function laneCounts(road){
  if(!hasLaneConfiguration(road))return {forward:1,backward:road.oneWay?0:1,total:road.oneWay?1:2};
  const forward=road.lanesForward,backward=road.lanesBackward;
  if(!Number.isInteger(forward)||!Number.isInteger(backward))throw new Error('两个方向的车道数必须为整数');
  if(road.oneWay){if(forward<1||forward>16||backward!==0)throw new Error('单向道路应为 1 至 16 条前向车道，反向车道为 0');}
  else if(forward<1||forward>8||backward<1||backward>8)throw new Error('双向道路每个方向应为 1 至 8 条车道');
  return {forward,backward,total:forward+backward};
}
export const roadWidth=road=>hasLaneConfiguration(road)?laneCounts(road).total*LANE_WIDTH+ROAD_SHOULDERS:road.width??9.3;
export function laneOffset(road,forward,index=0){
  const counts=laneCounts(road),count=forward?counts.forward:counts.backward;
  if(!Number.isInteger(index)||index<0||index>=count)throw new Error('车道编号超出通行方向的车道范围');
  if(!hasLaneConfiguration(road))return (forward?1:-1)*(road.width?road.width/4:2);
  const divider=(counts.backward-counts.total/2)*LANE_WIDTH;
  return divider+(forward?index+.5:-index-.5)*LANE_WIDTH;
}
export function laneKey(road,from,index=0){const count=from===road.a?laneCounts(road).forward:laneCounts(road).backward;return count===1?`${road.id}:${from}`:`${road.id}:${from}:${index}`;}

export const TURN_TYPES=Object.freeze(['left','through','right']);
export function copyLaneTurns(road){
  const counts=laneCounts(road),result={};
  for(const [key,count] of [['turnsForward',counts.forward],['turnsBackward',counts.backward]]){
    const value=road[key];if(value===undefined)continue;
    if(!Array.isArray(value))throw new Error('车道用途应为逐车道数组');
    if(!value.length)continue;if(value.length!==count)throw new Error('车道用途数量必须与对应方向的车道数一致');
    result[key]=value.map(turns=>{if(!Array.isArray(turns)||turns.some(turn=>!TURN_TYPES.includes(turn))||new Set(turns).size!==turns.length)throw new Error('车道用途仅支持左转、直行、右转，且不可重复');return [...turns];});
  }
  return result;
}
function travelTangent(network,road,forward,atEnd){
  const path=roadPath(network,road),p=pathPointAt(path,forward?(atEnd?path.length:0):(atEnd?0:path.length));
  return{x:p.tangentX*(forward?1:-1),z:p.tangentZ*(forward?1:-1)};
}
export function classifyTurn(network,inRoad,inForward,outRoad,outForward){
  const a=travelTangent(network,inRoad,inForward,true),b=travelTangent(network,outRoad,outForward,false);
  const angle=Math.atan2(a.x*b.z-a.z*b.x,a.x*b.x+a.z*b.z);
  return Math.abs(angle)<Math.PI/4?'through':Math.abs(angle)>Math.PI*.85||angle<0?'left':'right';
}
export function outgoingRoads(network,id){return network.roads.flatMap(road=>road.a===id?[{road,from:road.a,to:road.b,forward:true}]:road.b===id&&!road.oneWay?[{road,from:road.b,to:road.a,forward:false}]:[]);}
export function effectiveLaneTurns(network,road,forward,index=0){
  const count=forward?laneCounts(road).forward:laneCounts(road).backward;if(index<0||index>=count)return [];
  const specified=road[forward?'turnsForward':'turnsBackward']?.[index];if(specified?.length)return [...specified];
  const at=forward?road.b:road.a,all=outgoingRoads(network,at),nonReturning=all.filter(edge=>edge.road.id!==road.id),options=nonReturning.length?nonReturning:all;
  if(!nonReturning.length&&all.some(edge=>edge.road.id===road.id))return index===0?['left']:[];
  const available=new Set(options.map(edge=>classifyTurn(network,road,forward,edge.road,edge.forward)));
  if(!available.size)return [];
  if(count===1||available.size===1)return TURN_TYPES.filter(turn=>available.has(turn));
  if(available.has('left')&&available.has('through')&&available.has('right')){
    if(count===2)return index===0?['left','through']:['through','right'];
    return index===0?['left']:index===count-1?['right']:['through'];
  }
  if(available.has('left')&&available.has('through'))return index===0?['left']:['through'];
  if(available.has('through')&&available.has('right'))return index===count-1?['right']:['through'];
  return index<Math.ceil(count/2)?['left']:['right'];
}
export function laneAllowsMovement(network,inRoad,inForward,index,outRoad,outForward){
  const specified=inRoad[inForward?'turnsForward':'turnsBackward']?.[index];
  // 仅在死胡同尽头（节点无其他可通行出口）且未指定特定转向时，内侧车道才自动允许掉头
  if(inRoad.id===outRoad.id){
    const at=inForward?inRoad.b:inRoad.a;
    const hasOtherOut=outgoingRoads(network,at).some(edge=>edge.road.id!==inRoad.id);
    if(hasOtherOut)return false;
    if(specified?.length)return specified.includes('left');
    return index===0;
  }
  return effectiveLaneTurns(network,inRoad,inForward,index).includes(classifyTurn(network,inRoad,inForward,outRoad,outForward));
}
