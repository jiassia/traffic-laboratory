import {makePath,roadPath,roadPointAt,pathPointAt,projectOnPath,samplePath} from './geometry.mjs';
import {laneCounts,laneOffset,roadWidth,LANE_WIDTH,hasLaneConfiguration} from './lanes.mjs';
import {roadEndTrim,junctionLayout} from './junction-layout.mjs';

export const SIGNAL_STOP_SETBACK=6.5;
const angle=value=>Math.atan2(Math.sin(value),Math.cos(value));
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const move=(p,d,length)=>({x:p.x+d.x*length,z:p.z+d.z*length});
const axisFor=yaw=>Math.abs(Math.sin(yaw))>=Math.abs(Math.cos(yaw))?'ew':'ns';

// All dimensions are metres. heading follows vehicle motion; faceHeading points
// towards approaching drivers for a signal whose lens faces local positive Z.
export function trafficApproach(network,road,nodeId){
  const id=typeof nodeId==='string'?nodeId:nodeId.id;
  if(road.a!==id&&road.b!==id)throw new Error('信号灯路口不属于此道路');
  const path=roadPath(network,road),forward=road.b===id,sign=forward?1:-1;
  const counts=laneCounts(road),count=forward?counts.forward:counts.backward;
  const trim=roadEndTrim(network,road,id),s=forward?path.length-trim:trim;
  const center=roadPointAt(network,road,s),heading=angle(center.yaw+(forward?0:Math.PI));
  const travel={x:Math.sin(heading),z:Math.cos(heading)},right={x:Math.cos(heading),z:-Math.sin(heading)};
  const width=roadWidth(road),height=clamp(5.4+count*.22,5.8,8.2),setback=count>1?SIGNAL_STOP_SETBACK:0;
  const laneCenters=[],heads=[],stopLines=[],laneStops=[];
  for(let index=0;index<count;index++){
    const offset=laneOffset(road,forward,index);
    // Match simulation.makeLane rather than converting centreline distance by a
    // length ratio, which moves stop lines on curved/asymmetric carriageways.
    const lanePath=makePath(samplePath(path,0,path.length,3,offset));
    const mouth=roadPointAt(network,road,s,offset),mouthS=projectOnPath(lanePath,mouth).s;
    const mouthPose=pathPointAt(lanePath,mouthS),yaw=angle(mouthPose.yaw+(forward?0:Math.PI));
    const laneTravel={x:Math.sin(yaw),z:Math.cos(yaw)},laneRight={x:Math.cos(yaw),z:-Math.sin(yaw)};
    const stopS=clamp(mouthS-sign*setback,0,lanePath.length),stop=pathPointAt(lanePath,stopS);
    const stopYaw=angle(stop.yaw+(forward?0:Math.PI)),stopRight={x:Math.cos(stopYaw),z:-Math.sin(stopYaw)};
    const laneWidth=hasLaneConfiguration(road)?LANE_WIDTH:Math.min(LANE_WIDTH,width/count-1.2);
    laneCenters.push({x:mouth.x,z:mouth.z,index,offset,yaw});
    laneStops.push({x:stop.x,z:stop.z,index,yaw:stopYaw,laneS:forward?stopS:lanePath.length-stopS});
    stopLines.push([move(stop,stopRight,-laneWidth/2),move(stop,stopRight,laneWidth/2)]);
    const head=move(mouth,laneTravel,1.4);
    heads.push({...head,y:height,index,yaw,heading:yaw,faceHeading:angle(yaw+Math.PI),axis:axisFor(yaw),right:laneRight});
  }
  const polePoint=roadPointAt(network,road,s,sign*(width/2+1.4));
  const pole=move(polePoint,travel,1.4);
  // One mast per incoming carriageway, with one visible face over each lane.
  const crossbar=[{...pole,y:height+.65},...heads.map(h=>({x:h.x,y:height+.65,z:h.z}))];
  const stopLine=stopLines.length?[stopLines[0][0],...stopLines.map(line=>line[1])]:[];
  return {road,roadId:road.id,nodeId:id,path,forward,sign,legal:count>0,s,center,trim,count,width,height,setback,heading,faceHeading:angle(heading+Math.PI),axis:axisFor(heading),travel,right,laneCenters,laneStops,stopLine,stopLines,pole,heads,crossbar};
}

export function signalApproaches(network){
  const result=[];
  for(const node of junctionLayout(network).nodes){
    if(!network.signals?.[node.nodeId]?.enabled||node.arms.length<2)continue;
    for(const arm of node.arms){
      const approach=trafficApproach(network,arm.road,node.nodeId);
      if(approach.legal)result.push(approach);
    }
  }
  return result;
}

export function streetlightLayout(network,facility){
  const road=network.roads.find(item=>item.id===facility.roadId);
  if(!road)return {position:{x:facility.x,z:facility.z},heading:facility.heading||0,height:6,reach:2.1,lightTarget:{x:facility.x,z:facility.z}};
  const path=roadPath(network,road),side=facility.side===-1?-1:1,width=roadWidth(road);
  const start=roadEndTrim(network,road,road.a),end=path.length-roadEndTrim(network,road,road.b);
  const low=Math.min(path.length/2,start+3),high=Math.max(low,Math.max(path.length/2,end-3));
  const s=clamp(Number.isFinite(facility.s)?facility.s:path.length/2,low,high);
  const center=roadPointAt(network,road,s),position=roadPointAt(network,road,s,side*(width/2+1.6));
  const inward={x:center.x-position.x,z:center.z-position.z};
  const norm=Math.hypot(inward.x,inward.z)||1,reach=clamp(width*.24,2.1,7.5),height=clamp(5.8+width*.12,6,12);
  return {roadId:road.id,s,side,position:{x:position.x,z:position.z},heading:Math.atan2(-inward.z,inward.x),height,reach,
    lightTarget:{x:position.x+inward.x/norm*reach,z:position.z+inward.z/norm*reach},spacing:clamp(height*3.1,20,38)};
}
