import {pathPointAt,roadPath} from './geometry.mjs';
import {laneCounts,laneKey,roadWidth,classifyTurn,effectiveLaneTurns,laneAllowsMovement} from './lanes.mjs';
import {bodyOverlap,sweptBodyOverlap,collisionPairs} from './incidents.mjs';
import {terminalIds} from './terminals.mjs';

const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const finite=(value,min,max)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;
const clone=value=>JSON.parse(JSON.stringify(value));
export {WEATHER_REFERENCE as WEATHER_PARAMETERS} from './vehicle-profiles.mjs';
import {WEATHER_REFERENCE as WEATHER_PARAMETERS} from './vehicle-profiles.mjs';
export function stoppingSightSpeed(brake,friction,visibility,timeHeadway){
  const b=brake*friction,T=Math.max(0,timeHeadway),distance=Math.max(0,visibility);if(b<=0)return 0;
  return Math.max(0,Math.sqrt((b*T)**2+2*b*distance)-b*T);
}

export function createTrafficEngine(inputNetwork,inputSettings,ctx){
  const {checkedNetwork,checkedSettings,validateNetwork,makeLane,point,connector,curvePoint,random,shortestPath,signalPhase,VEHICLE_TYPES,FIXED_STEP,MODEL_VERSION,MAX_ACTIVE,MIN_GAP}=ctx;
  const network=checkedNetwork(inputNetwork),validation=validateNetwork(network);if(!validation.valid)throw new Error(validation.reason);
  let settings=checkedSettings(inputSettings),tick=0,remainder=0,nextId=1,demandCredit=0,nextIncidentId=1;
  const cars=[],queue=[],events=[],reservations=new Map(),incidents=[],blockedRequests=new Set();
  const sourceIds=terminalIds(network,'source'),sinkIds=terminalIds(network,'sink'),sinkSet=new Set(sinkIds);
  const routes=new Map(sourceIds.map(source=>[source,new Map(sinkIds.map(sink=>[sink,shortestPath(network,source,sink)]).filter(([,route])=>route.length))]));
  const sourceCounts=Object.fromEntries(sourceIds.map(id=>[id,{requested:0,arrived:0,removed:0}])),sinkCounts=Object.fromEntries(sinkIds.map(id=>[id,{requested:0,arrived:0,removed:0,targetCompleted:0}]));let admissionCursor=0;
  const roadById=new Map(network.roads.map(r=>[r.id,r]));
  const stopSignsByLane=new Map();for(const sign of network.facilities)if(sign.type==='stopSign'&&sign.roadId){const key=`${sign.roadId}:${sign.side}`;if(!stopSignsByLane.has(key))stopSignsByLane.set(key,[]);stopSignsByLane.get(key).push(sign);}
  const lanes=new Map();
  const laneFor=(road,from,index=0)=>{const key=laneKey(road,from,index);if(!lanes.has(key))lanes.set(key,makeLane(network,road,from,index));return lanes.get(key);};
  let occupancyCache=null;
  const counts={requested:0,arrived:0,removed:0,breakdowns:0,violations:0,safetyCorrections:0,totalTravel:0,collisions:0,clearedIncidents:0};
  const log=(type,data={})=>{events.push({tick,time:tick*FIXED_STEP,type,...data});};
  const request=()=>{const sourceId=sourceIds[counts.requested%sourceIds.length],targets=[...routes.get(sourceId).keys()],targetSinkId=targets[sourceCounts[sourceId].requested%targets.length];queue.push({id:nextId++,requestedAt:tick*FIXED_STEP,sourceId,targetSinkId});sourceCounts[sourceId].requested++;sinkCounts[targetSinkId].requested++;counts.requested++;};
  const weather=()=>WEATHER_PARAMETERS[settings.weather];
  const effectivePhase=nodeId=>signalPhase(network.signals[nodeId],tick*FIXED_STEP,settings.signalMode);
  const body=car=>({...car.crashPose??(car.turn?curvePoint(car.turn,car.turnS):point(car.lane,car.s)),length:car.type.length,width:car.type.width,id:car.id,speed:car.speed});
  const compliant=id=>random(settings.seed,id,11)<settings.compliance/100;
  const canonicalS=car=>(car.lane.forward?car.s:car.lane.length-car.s)/car.lane.length*car.lane.centerPath.length;
  const laneS=(lane,s)=>((lane.forward?s:lane.centerPath.length-s)/lane.centerPath.length)*lane.length;
  const pendingStops=car=>(stopSignsByLane.get(`${car.lane.road.id}:${car.lane.forward?1:-1}`)||[]).filter(sign=>!car.stopSigns.has(sign.id)).map(sign=>({sign,s:Math.min(car.lane.length-car.lane.trim,laneS(car.lane,sign.s))}));
  if(settings.demand>0){request();log('initial-demand',{count:1});}

  function choicesAt(id){return network.roads.flatMap(r=>r.a===id?[{road:r,from:r.a,to:r.b}]:r.b===id&&!r.oneWay?[{road:r,from:r.b,to:r.a}]:[]).sort((a,b)=>a.road.id.localeCompare(b.road.id));}
  function unknownPlan(car,at){
    const choices=choicesAt(at);if(!choices.length)return null;
    const memoryStack=[...car.memoryStack],visitedNodes=new Set(car.visitedNodes),visited=new Set(car.visited);
    const index=memoryStack.indexOf(at);if(index>=0)memoryStack.length=index+1;else memoryStack.push(at);visitedNodes.add(at);
    let available=choices.filter(edge=>!visitedNodes.has(edge.to));
    if(!available.length){const parent=memoryStack.at(-2),back=choices.find(edge=>edge.to===parent),unused=choices.filter(edge=>!visited.has(`${edge.road.id}:${at}`));available=back?[back]:unused.length?unused:choices;}
    const edge=available[Math.floor(random(settings.seed,car.id,100+car.decisions)*available.length)];visited.add(`${edge.road.id}:${at}`);
    return {at,edge,memoryStack,visitedNodes,visited,decisions:car.decisions+1};
  }
  function choose(car,at){
    if(car.knownExit){
      const edge=car.route[car.routeIndex];if(!edge)return null;const next=car.route[car.routeIndex+1],lane=selectLane(edge.road,edge.from,car,next);
      if(lane){car.routeIndex++;car.selectedNextEdge=next;car.blockedReason=null;}else car.blockedReason='no-compatible-turn-lane';return lane;
    }
    const plan=car.nextPlan?.at===at?car.nextPlan:unknownPlan(car,at);if(!plan)return null;
    const nextPlan=unknownPlan({...car,...plan},plan.edge.to),lane=selectLane(plan.edge.road,plan.edge.from,car,nextPlan?.edge);
    if(!lane){car.blockedReason='no-compatible-turn-lane';return null;}
    car.memoryStack=plan.memoryStack;car.visitedNodes=plan.visitedNodes;car.visited=plan.visited;car.decisions=plan.decisions;car.nextPlan=nextPlan;car.selectedNextEdge=nextPlan?.edge;car.blockedReason=null;return lane;
  }
  function laneOccupants(key,exclude){
    if(occupancyCache)return(occupancyCache.get(key)||[]).filter(item=>item.car!==exclude);
    const items=[];
    for(const car of cars)if(car!==exclude){
      if(!car.turn&&car.lane.key===key)items.push({s:car.s,speed:car.speed,length:car.type.length,car});
      else if(car.turn&&car.turn.outLane.key===key)items.push({s:car.turn.outLane.trimStart-(car.turn.length-car.turnS),speed:car.speed,length:car.type.length,car});
      else if(car.turn&&car.lane.key===key)items.push({s:car.lane.length-car.lane.trim+car.turnS,speed:car.speed,length:car.type.length,car});
    }
    return items.sort((a,b)=>a.s-b.s);
  }
  function cacheLaneOccupants(){
    const map=new Map(),add=(key,car,s)=>{if(!map.has(key))map.set(key,[]);map.get(key).push({s,speed:car.speed,length:car.type.length,car});};
    for(const car of cars)if(car.turn){add(car.turn.outLane.key,car,car.turn.outLane.trimStart-(car.turn.length-car.turnS));add(car.lane.key,car,car.lane.length-car.lane.trim+car.turnS);}else add(car.lane.key,car,car.s);
    for(const items of map.values())items.sort((a,b)=>a.s-b.s);occupancyCache=map;
  }
  function admit(){
    if(!queue.length||cars.length>=MAX_ACTIVE)return;
    const start=admissionCursor;admissionCursor=(admissionCursor+1)%sourceIds.length;
    for(let offset=0;offset<sourceIds.length&&cars.length<MAX_ACTIVE;offset++){
    const sourceId=sourceIds[(start+offset)%sourceIds.length],index=queue.findIndex(req=>req.sourceId===sourceId);if(index<0||reservations.has(sourceId))continue;
    const req=queue[index],type=VEHICLE_TYPES[(Math.floor((req.id-1)/sourceIds.length)+(req.id-1)%sourceIds.length)%VEHICLE_TYPES.length];
    const car={id:req.id,type,sourceId,targetSinkId:req.targetSinkId,knownExit:settings.knownExit,compliant:compliant(req.id),route:routes.get(sourceId).get(req.targetSinkId),routeIndex:0,visited:new Set(),visitedNodes:new Set(),memoryStack:[],decisions:0,s:0,speed:0,accel:0,distance:0,enteredAt:tick*FIXED_STEP,requestedAt:req.requestedAt,turn:null,turnS:0,pending:null,held:[],event:null,eventQueue:[],eventStarted:false,eventTriggered:false,violationOccurred:false,breakdownOccurred:false,stopSigns:new Set(),incidentId:null,crashed:false,crashPose:null,desiredSpeed:0};
    car.lane=choose(car,sourceId);if(!car.lane){if(car.blockedReason&&!blockedRequests.has(req.id)){blockedRequests.add(req.id);log('turn-lane-blocked',{vehicleId:req.id,nodeId:sourceId,reason:car.blockedReason});}continue;}blockedRequests.delete(req.id);car.laneNextEdge=car.selectedNextEdge;car.s=type.length/2;
    if(laneOccupants(car.lane.key).some(item=>item.s-item.length/2<car.s+type.length/2+MIN_GAP))continue;
    const broken=random(settings.seed,car.id,1)<settings.breakdown/100;
    const violation=settings.violations.length&&random(settings.seed,car.id,2)<settings.violation/100?settings.violations[Math.floor(random(settings.seed,car.id,3)*settings.violations.length)]:null;
    car.violation=violation;car.breakdown=broken;
    if(broken)car.eventQueue.push({name:'breakdown',duration:8});if(violation==='parking')car.eventQueue.push({name:'parking',duration:4});if(violation==='hesitation')car.eventQueue.push({name:'hesitation',duration:3});
    cars.push(car);queue.splice(index,1);log('entered',{vehicleId:car.id,typeId:type.id,sourceId,targetSinkId:car.targetSinkId,breakdown:broken,violation,compliant:car.compliant});
    }
  }
  const owners=node=>reservations.get(node)||new Set();
  function release(node,id){const set=reservations.get(node);if(set){set.delete(id);if(!set.size)reservations.delete(node);}cars.find(car=>car.id===id)?.grants?.delete(node);}
  const stableLanePreference=(id,count)=>(id-1+Math.floor((id-1)/count))%count;
  function selectLane(road,from,car,nextEdge){
    const count=from===road.a?laneCounts(road).forward:laneCounts(road).backward;
    let preferred=stableLanePreference(car.id,count);
    if(car.lane){
      const kind=classifyTurn(network,car.lane.road,car.lane.forward,road,from===road.a),before=car.lane.forward?laneCounts(car.lane.road).forward:laneCounts(car.lane.road).backward;
      preferred=before===1?stableLanePreference(car.id,count):kind==='left'?0:kind==='right'?count-1:Math.round(car.lane.index/(before-1)*(count-1));
    }
    const candidates=Array.from({length:count},(_,index)=>{
      const lane=laneFor(road,from,index),items=laneOccupants(lane.key,car),first=items[0],space=first?first.s-first.length/2:lane.length;
      const entry=car.lane?lane.trimStart:car.type.length/2,required=entry+car.type.length/2+MIN_GAP;
      const reserved=cars.some(other=>other!==car&&[...(other.grants?.values()||[])].some(grant=>grant.outLane?.key===lane.key));
      const blocked=space<required||reserved,entranceLoad=items.filter(item=>item.s-item.length/2<required+25).length;
      return{lane,space,load:items.length,entranceLoad,blocked,index};
    }).filter(item=>!nextEdge||laneAllowsMovement(network,road,from===road.a,item.index,nextEdge.road,nextEdge.from===nextEdge.road.a));
    candidates.sort((a,b)=>Number(a.blocked)-Number(b.blocked)||a.entranceLoad-b.entranceLoad||Math.abs(a.index-preferred)-Math.abs(b.index-preferred)||a.load-b.load||b.space-a.space||a.index-b.index);
    return candidates[0]?.lane||null;
  }
  function withBounds(grant){const xs=grant.points.map(p=>p.x),zs=grant.points.map(p=>p.z);return{...grant,straight:grant.points.every(p=>Math.abs(Math.atan2(Math.sin(p.yaw-grant.points[0].yaw),Math.cos(p.yaw-grant.points[0].yaw)))<.002),bounds:{minX:Math.min(...xs),maxX:Math.max(...xs),minZ:Math.min(...zs),maxZ:Math.max(...zs)}};}
  function movement(car){
    if(car.pending){const turn=connector(car.lane,car.pending);return withBounds(turn);}
    const lane=car.lane,a=point(lane,lane.length-lane.trim),b=point(lane,lane.length+car.type.length);
    return withBounds({points:[a,b],length:lane.trim+car.type.length,outLane:null,junction:lane.to});
  }
  function conflicts(car,grant,other){
    const previous=other.grants?.get(grant.junction);if(!previous)return true;
    const aCount=laneCounts(car.lane.road),bCount=laneCounts(previous.inLane.road);
    if((car.lane.forward?aCount.forward:aCount.backward)===1&&(previous.inLane.forward?bCount.forward:bCount.backward)===1)return true;
    if(car.lane.key===previous.inLane.key||car.pending&&previous.outLane?.key===car.pending.key)return true;
    const widthLimit=(car.type.width+other.type.width)/2+.35;
    const first=grant.points[0],second=previous.points[0],headingDifference=Math.abs(Math.sin(first.yaw-second.yaw));
    if(grant.straight&&previous.straight&&headingDifference<.002&&Math.abs((first.x-second.x)*Math.cos(first.yaw)-(first.z-second.z)*Math.sin(first.yaw))>widthLimit)return false;
    const limit=(Math.hypot(car.type.length,car.type.width)+Math.hypot(other.type.length,other.type.width))/2;
    const a=grant.bounds,b=previous.bounds;if(a&&b&&(a.minX-b.maxX>limit||b.minX-a.maxX>limit||a.minZ-b.maxZ>limit||b.minZ-a.maxZ>limit))return false;
    for(let i=0;i<grant.points.length;i+=2){const a=grant.points[i];for(let j=0;j<previous.points.length;j+=2){const b=previous.points[j];if(Math.hypot(a.x-b.x,a.z-b.z)>limit)continue;if(bodyOverlap({...a,length:car.type.length,width:car.type.width},{...b,length:other.type.length,width:other.type.width},-.15))return true;}}
    return false;
  }
  function movementHasBodySpace(car,grant){
    const radius=Math.hypot(car.type.length,car.type.width)/2,b=grant.bounds;
    for(const other of cars){
      if(other===car)continue;const pose=body(other),otherRadius=Math.hypot(other.type.length,other.type.width)/2;
      if(pose.x<b.minX-radius-otherRadius||pose.x>b.maxX+radius+otherRadius||pose.z<b.minZ-radius-otherRadius||pose.z>b.maxZ+radius+otherRadius)continue;
      for(let i=0;i<grant.points.length;i+=2){const p=grant.points[i];if(bodyOverlap({x:p.x,z:p.z,yaw:p.yaw,length:car.type.length,width:car.type.width},pose))return false;}
    }
    return true;
  }
  function obtain(car){
    const lane=car.lane,node=lane.to;if(car.incidentId)return false;
    const owned=owners(node);if(owned.has(car.id))return true;
    const end=point(lane,lane.length-lane.trim),axis=Math.abs(Math.sin(end.yaw))>=Math.abs(Math.cos(end.yaw))?'ew':'ns',phase=effectivePhase(node);
    if(!sinkSet.has(node)&&!car.pending){car.pending=choose(car,node);car.pendingNextEdge=car.selectedNextEdge;}
    if(!sinkSet.has(node)&&!car.pending){if(car.blockedReason&&!car.turnBlockLogged){car.turnBlockLogged=true;log('turn-lane-blocked',{vehicleId:car.id,nodeId:node,laneId:lane.key,reason:car.blockedReason});}return false;}
    if(car.pending){const previous=car.pending;car.pending=selectLane(previous.road,previous.from,car,car.pendingNextEdge);if(!car.pending)return false;if(!laneAllowsMovement(network,lane.road,lane.forward,lane.index,car.pending.road,car.pending.forward)){car.blockedReason='turn-not-allowed';if(!car.turnBlockLogged){car.turnBlockLogged=true;log('turn-lane-blocked',{vehicleId:car.id,nodeId:node,laneId:lane.key,reason:car.blockedReason});}return false;}car.blockedReason=null;}
    if(!car.compliant){car.unsafePermit=node;if((phase[axis]!=='green'||owned.size)&&!car.ruleBroken){car.ruleBroken=true;counts.violations++;log('rule-ignored',{vehicleId:car.id,nodeId:node,phase:phase[axis]});}return true;}
    if(pendingStops(car).some(({s})=>s>=car.s+car.type.length/2-.3))return false;
    if(laneOccupants(lane.key,car).some(item=>item.s>car.s))return false;
    if(phase[axis]!=='green')return false;
    if(car.pending){
      const start=car.pending.trimStart,space=car.type.length/2+MIN_GAP;
      if(laneOccupants(car.pending.key,car).some(item=>item.s-item.length/2<start+space))return false;
      if(cars.some(other=>other!==car&&other.turn&&other.turn.outLane.key===car.pending.key))return false;
    }
    const grant=movement(car);if(!movementHasBodySpace(car,grant))return false;
    for(const id of owned){const other=cars.find(item=>item.id===id);if(other&&conflicts(car,grant,other))return false;}
    if(!reservations.has(node))reservations.set(node,new Set());reservations.get(node).add(car.id);car.held.push(node);car.grants??=new Map();car.grants.set(node,{...grant,inLane:lane});log('junction-enter',{vehicleId:car.id,nodeId:node,phase:phase[axis]});
    if(car.violation==='priority'&&!car.violationOccurred){car.violationOccurred=true;counts.violations++;log('violation-start',{vehicleId:car.id,kind:'priority'});}return true;
  }
  const permitted=car=>owners(car.lane.to).has(car.id)||car.unsafePermit===car.lane.to;

  function addIncident(type,affected,source='simulation',severity=0,position=null){
    const live=affected.filter(car=>!car.incidentId);if(!live.length)return null;
    const location=position||body(live[0]),id=`incident_${nextIncidentId++}`;
    const incident={id,type,phase:'blocked',x:location.x,z:location.z,vehicleIds:live.map(car=>car.id),age:0,remaining:settings.incidentDuration,duration:settings.incidentDuration,severity,source,cleared:false};
    for(const car of live){car.crashPose=body(car);car.incidentId=id;car.crashed=type!=='breakdown';car.event=type;car.speed=0;car.accel=0;car.desiredSpeed=0;}
    if(type==='collision')counts.collisions++;if(type==='breakdown')counts.breakdowns++;incidents.push(incident);log('incident-start',{incidentId:id,kind:type,phase:incident.phase,source,vehicleIds:[...incident.vehicleIds],severity});return incident;
  }
  function clearIncident(id,source='manual'){
    const index=incidents.findIndex(incident=>incident.id===id);if(index<0)return false;const incident=incidents[index];
    for(let i=cars.length-1;i>=0;i--){const car=cars[i];if(car.incidentId!==id)continue;
      if(incident.type==='breakdown'){car.incidentId=null;car.crashPose=null;car.crashed=false;car.event=null;}else{for(const node of car.held)release(node,car.id);counts.removed++;sourceCounts[car.sourceId].removed++;sinkCounts[car.targetSinkId].removed++;log('vehicle-removed',{vehicleId:car.id,sourceId:car.sourceId,targetSinkId:car.targetSinkId,reason:'incident-clearance',incidentId:id});cars.splice(i,1);}
    }

    incidents.splice(index,1);counts.clearedIncidents++;occupancyCache=null;log('incident-cleared',{incidentId:id,source,vehicleIds:[...incident.vehicleIds]});return true;
  }
  function stepIncidents(){
    const clear=[];for(const incident of incidents){incident.age+=FIXED_STEP;incident.remaining=Math.max(0,incident.duration-incident.age);incident.phase=incident.type==='breakdown'?'blocked':incident.remaining<incident.duration*.2?'recovery':'blocked';for(const car of cars)if(car.incidentId===incident.id)car.event=incident.type==='breakdown'?'breakdown':incident.phase;if(incident.remaining<=1e-9)clear.push(incident.id);}
    for(const id of clear)clearIncident(id,'simulation');
  }
  function injectIncident({type,vehicleId}={}){
    if(!['breakdown','collision'].includes(type))throw new Error('可注入故障或碰撞情景');
    const car=vehicleId===undefined?cars.find(item=>!item.incidentId):cars.find(item=>item.id===Number(vehicleId)&&!item.incidentId);if(!car)throw new Error('当前没有可设置事故的车辆，请先让车辆进入道路');
    const affected=[car];if(type==='collision'){const p=body(car),near=cars.filter(other=>other!==car&&!other.incidentId).map(other=>({other,d:Math.hypot(body(other).x-p.x,body(other).z-p.z)})).sort((a,b)=>a.d-b.d)[0];if(near&&near.d<12)affected.push(near.other);}
    return clone(addIncident(type,affected,'manual',car.speed));
  }
  function detectCollisions(previous){
    if(!settings.accidentsEnabled)return;
    const poses=cars.map(body);
    for(const[a,b]of collisionPairs(poses)){
      const carA=cars[a],carB=cars[b];if(carA.incidentId&&carB.incidentId)continue;
      const oldA=previous.get(carA.id)||poses[a],oldB=previous.get(carB.id)||poses[b];
      if(Math.max(poses[a].speed,poses[b].speed)<.2)continue;
      if(sweptBodyOverlap(oldA,poses[a],oldB,poses[b])){
        const av={x:Math.sin(poses[a].yaw)*poses[a].speed,z:Math.cos(poses[a].yaw)*poses[a].speed},bv={x:Math.sin(poses[b].yaw)*poses[b].speed,z:Math.cos(poses[b].yaw)*poses[b].speed},impact=Math.hypot(av.x-bv.x,av.z-bv.z);
        addIncident('collision',[carA,carB],'simulation',impact,{x:(poses[a].x+poses[b].x)/2,z:(poses[a].z+poses[b].z)/2});
      }
    }

  }

  function fixedStep(){
    tick++;occupancyCache=null;stepIncidents();
    demandCredit+=settings.demand*FIXED_STEP/60;while(demandCredit>=1-1e-10){request();demandCredit-=1;}
    admit();cacheLaneOccupants();
    const previous=settings.accidentsEnabled?new Map(cars.map(car=>[car.id,body(car)])):null;
    const ordered=[...cars].sort((a,b)=>(a.violation==='priority'?-1:0)-(b.violation==='priority'?-1:0)||a.enteredAt-b.enteredAt||a.id-b.id);
    for(const car of ordered){if(car.turn||car.incidentId)continue;const remain=car.lane.length-car.lane.trim-car.s-car.type.length/2-MIN_GAP;const terminalSignal=network.signals[car.lane.to]?.enabled;if((!sinkSet.has(car.lane.to)||terminalSignal)&&remain<Math.max(18,car.speed*car.speed/(2*car.type.brake*weather().friction)+4))obtain(car);}
    const proposals=[];
    for(const car of cars){
      if(car.incidentId){proposals.push({car,move:0,speed:0,acc:0,gap:Infinity,normalLimit:0});continue;}
      const conditions=weather(),local=point(car.lane,car.s),curvature=Math.abs(local.curvature||0),curveSpeed=Math.sqrt((car.type.id==='bus'||car.type.id==='truck'?1.6:2.2)/Math.max(curvature,1e-6));
      const T=(car.type.timeHeadway??(car.type.id==='bus'||car.type.id==='truck'?2:1.5))*settings.reactionTime*(car.compliant?1:.45);
      let gap=Infinity,leaderSpeed=0,target=Math.min(settings.speeds[car.type.id],car.lane.road.speedLimit)/3.6*conditions.speedFactor;
      target=Math.min(target,curveSpeed,stoppingSightSpeed(car.type.brake,conditions.friction,conditions.visibility,T));const normalLimit=target;
      if(car.lane.path.points.length>2&&!car.turn)for(const distance of[5,12,25,45]){if(car.s+distance>=car.lane.length-car.lane.trim)break;const ahead=point(car.lane,car.s+distance),curveLimit=Math.sqrt((car.type.id==='bus'||car.type.id==='truck'?1.6:2.2)/Math.max(Math.abs(ahead.curvature||0),1e-6));target=Math.min(target,Math.sqrt(curveLimit*curveLimit+2*car.type.brake*conditions.friction*distance));}
      if(car.violation==='speeding'||!car.compliant)target=Math.min(140/3.6,target*(car.compliant?1.3:1.45));
      if(car.turn)target=Math.min(target,car.compliant?3.5:7);
      const occupant=car.turn?null:laneOccupants(car.lane.key,car).find(item=>item.s>car.s);
      if(occupant){gap=occupant.s-car.s-(occupant.length+car.type.length)/2;leaderSpeed=occupant.speed;}
      if(!car.turn&&(!sinkSet.has(car.lane.to)||network.signals[car.lane.to]?.enabled)){
        if(!permitted(car)){const counts=laneCounts(car.lane.road),setback=(car.lane.forward?counts.forward:counts.backward)>1?6.5:0,stopGap=car.lane.length-car.lane.trim-setback-car.s-car.type.length/2;if(stopGap<gap){gap=stopGap;leaderSpeed=0;}}
        const distance=Math.max(0,car.lane.length-car.lane.trim-car.s);target=Math.min(target,Math.sqrt((car.compliant?3.5:7)**2+2*car.type.brake*conditions.friction*distance));
      }
      if(car.compliant&&!car.turn){
        for(const {sign,s} of pendingStops(car)){const distance=s-car.s-car.type.length/2;if(distance<-.3){car.stopSigns.add(sign.id);continue;}if(car.speed<.1&&distance<1){car.stopWait=(car.stopWait||0)+FIXED_STEP;if(car.stopWait>=1){car.stopSigns.add(sign.id);car.stopWait=0;log('stop-sign-complete',{vehicleId:car.id,facilityId:sign.id});continue;}}if(distance<gap){gap=Math.max(0,distance);leaderSpeed=0;}}
      }
      if(car.eventQueue.length&&!car.eventTriggered&&car.distance>Math.max(8,car.lane.length*.28)&&!car.turn&&!car.held.length){car.eventTriggered=true;car.event=car.eventQueue[0].name;}
      if(car.eventTriggered&&car.eventQueue.length){target=0;if(car.speed<.05){if(!car.eventStarted){const current=car.eventQueue[0];car.eventStarted=true;car.eventRemaining=current.duration;car.event=current.name;if(current.name==='breakdown'){counts.breakdowns++;car.breakdownOccurred=true;}else{counts.violations++;car.violationOccurred=true;}log('event-start',{vehicleId:car.id,kind:current.name});}car.eventRemaining-=FIXED_STEP;if(car.eventRemaining<=1e-9){log('event-end',{vehicleId:car.id,kind:car.eventQueue[0].name});car.eventQueue.shift();car.eventStarted=false;car.event=car.eventQueue[0]?.name??null;}}}
      const a=car.type.accel,b=car.type.brake*conditions.friction;
      let acc=target<=0?-b:a*(1-Math.pow(car.speed/Math.max(.1,target),4));
      if(Number.isFinite(gap)){const desired=(car.type.minGap??MIN_GAP)+Math.max(0,car.speed*T+car.speed*(car.speed-leaderSpeed)/(2*Math.sqrt(a*b)));acc-=a*Math.pow(desired/Math.max(.1,gap),2);}
      acc=clamp(acc,-Math.max(car.compliant?4.5:2,car.type.brake*(car.compliant?3:1.4))*conditions.friction,a);
      const v=Math.max(0,car.speed+acc*FIXED_STEP),move=car.speed+acc*FIXED_STEP<0?-car.speed*car.speed/(2*acc):car.speed*FIXED_STEP+.5*acc*FIXED_STEP*FIXED_STEP;
      car.desiredSpeed=target;car.curveSpeed=curveSpeed;proposals.push({car,move:Math.max(0,move),speed:v,acc,gap,normalLimit});
    }
    for(const proposal of proposals){
      const car=proposal.car;if(car.incidentId)continue;let move=proposal.move;
      if((car.compliant||!settings.accidentsEnabled)&&Number.isFinite(proposal.gap)&&move>Math.max(0,proposal.gap-.05)){move=Math.max(0,proposal.gap-.05);proposal.speed=0;counts.safetyCorrections++;log('safety-correction',{vehicleId:car.id,metres:proposal.move-move});}
      car.accel=proposal.acc;car.speed=proposal.speed;car.distance+=move;
      if(car.violation==='speeding'&&!car.violationOccurred&&car.speed>proposal.normalLimit+.25){car.violationOccurred=true;counts.violations++;log('violation-start',{vehicleId:car.id,kind:'speeding'});}
      if(car.turn){car.turnS+=move;if(car.turnS>=car.turn.length){car.s=car.turn.outLane.trimStart+car.turnS-car.turn.length;car.lane=car.turn.outLane;car.laneNextEdge=car.pendingNextEdge;car.turn=null;car.turnS=0;car.pending=null;car.unsafePermit=null;}}
      else{car.s+=move;if(!sinkSet.has(car.lane.to)&&car.s>=car.lane.length-car.lane.trim&&permitted(car)&&car.pending){car.turn=connector(car.lane,car.pending);car.turnS=car.s-(car.lane.length-car.lane.trim);car.s=car.lane.length-car.lane.trim;}}
      if(!car.turn)for(const held of[...car.held])if(held===car.lane.from&&car.s>car.lane.trimStart+car.type.length/2+MIN_GAP){release(held,car.id);car.held=car.held.filter(node=>node!==held);log('junction-exit',{vehicleId:car.id,nodeId:held});}
    }
    if(settings.accidentsEnabled)detectCollisions(previous);
    for(let i=cars.length-1;i>=0;i--){const car=cars[i];if(!car.incidentId&&!car.turn&&sinkSet.has(car.lane.to)&&car.s-car.type.length/2>=car.lane.length){counts.arrived++;sourceCounts[car.sourceId].arrived++;sinkCounts[car.lane.to].arrived++;sinkCounts[car.targetSinkId].targetCompleted++;counts.totalTravel+=tick*FIXED_STEP-car.enteredAt;for(const node of car.held)release(node,car.id);log('arrived',{vehicleId:car.id,sourceId:car.sourceId,sinkId:car.lane.to,targetSinkId:car.targetSinkId,travelTime:tick*FIXED_STEP-car.enteredAt});cars.splice(i,1);}}
  }
  function snapshot(options={}){
    const vehicles=cars.map(car=>{const pose=body(car);let curvature=point(car.lane,car.s).curvature;if(car.turn){const start=Math.max(0,car.turnS-.25),end=Math.min(car.turn.length,car.turnS+.25),a=curvePoint(car.turn,start),b=curvePoint(car.turn,end);curvature=Math.atan2(Math.sin(b.yaw-a.yaw),Math.cos(b.yaw-a.yaw))/Math.max(.001,end-start);}return{x:pose.x,z:pose.z,yaw:pose.yaw,id:car.id,sourceId:car.sourceId,targetSinkId:car.targetSinkId,typeId:car.type.id,speed:car.speed,distance:car.distance,braking:car.accel<-.3,event:car.event??(car.violation==='speeding'&&car.violationOccurred?'speeding':null),length:car.type.length,width:car.type.width,laneId:car.turn?null:car.lane.key,laneIndex:car.lane.index,laneTurns:effectiveLaneTurns(network,car.lane.road,car.lane.forward,car.lane.index),plannedTurn:car.laneNextEdge?classifyTurn(network,car.lane.road,car.lane.forward,car.laneNextEdge.road,car.laneNextEdge.from===car.laneNextEdge.road.a):null,blockedReason:car.blockedReason??null,junctionId:car.turn?.junction??null,roadId:car.lane.road.id,compliant:car.compliant,crashed:car.crashed,incidentId:car.incidentId,steeringAngle:clamp(Math.atan((car.type.length*.6)*(curvature||0)),-.7,.7),desiredSpeed:car.desiredSpeed};});
    const roadStats={};for(const road of network.roads){const c=laneCounts(road),laneMetres=Array.from({length:c.forward},(_,i)=>laneFor(road,road.a,i).length).reduce((a,b)=>a+b,0)+Array.from({length:c.backward},(_,i)=>laneFor(road,road.b,i).length).reduce((a,b)=>a+b,0);roadStats[road.id]={roadId:road.id,laneCount:c.total,vehicleCount:0,meanSpeedKmh:null,freeSpeedKmh:road.speedLimit*weather().speedFactor,speedRatio:null,densityVehPerKm:0,queuedVehicles:0,level:'empty',label:'无车辆',_speed:0,_free:0,_body:0,_laneMetres:laneMetres};}
    for(const car of cars){const r=roadStats[car.lane.road.id];r.vehicleCount++;r._speed+=car.speed*3.6;r._free+=Math.min(car.lane.road.speedLimit,settings.speeds[car.type.id])*weather().speedFactor;r._body+=car.type.length;if(car.speed<1)r.queuedVehicles++;}
    for(const r of Object.values(roadStats)){if(r.vehicleCount){r.meanSpeedKmh=r._speed/r.vehicleCount;r.freeSpeedKmh=r._free/r.vehicleCount;r.speedRatio=r.meanSpeedKmh/r.freeSpeedKmh;r.densityVehPerKm=r.vehicleCount*1000/r._laneMetres;const occupancy=r._body/r._laneMetres,queueRatio=r.queuedVehicles/r.vehicleCount,substantialQueue=r.queuedVehicles>=2&&queueRatio>=.35,dense=occupancy>=.08||r.densityVehPerKm>=12;if(dense&&r.speedRatio<.35&&(substantialQueue||r.vehicleCount>=3)){r.level='congested';r.label='拥堵';}else if(r.speedRatio<.7&&(r.queuedVehicles>0||r.vehicleCount>=2)){r.level='slow';r.label='缓行';}else{r.level='free';r.label='畅通';}}delete r._speed;delete r._free;delete r._body;delete r._laneMetres;}
    const summaries=Object.values(roadStats);
    const portStats={sources:Object.fromEntries(sourceIds.map(id=>[id,{...sourceCounts[id],queued:queue.filter(req=>req.sourceId===id).length,active:cars.filter(car=>car.sourceId===id).length}])),sinks:Object.fromEntries(sinkIds.map(id=>[id,{...sinkCounts[id],queued:queue.filter(req=>req.targetSinkId===id).length,active:cars.filter(car=>car.targetSinkId===id).length}]))};
    return{modelVersion:MODEL_VERSION,time:tick*FIXED_STEP,tick,vehicles,roadStats,incidents:incidents.map(({duration,cleared,...incident})=>({...incident,vehicleIds:[...incident.vehicleIds]})),stats:{portStats,requested:counts.requested,queued:queue.length,active:cars.length,arrived:counts.arrived,removed:counts.removed,turnLaneBlocked:blockedRequests.size+cars.filter(car=>car.blockedReason).length,waiting:queue.length+cars.filter(car=>car.speed<.5).length,meanTravelTime:counts.arrived?counts.totalTravel/counts.arrived:null,breakdowns:counts.breakdowns,violations:counts.violations,safetyCorrections:counts.safetyCorrections,collisions:counts.collisions,activeIncidents:incidents.length,clearedIncidents:counts.clearedIncidents,congestedRoads:summaries.filter(r=>r.level==='congested').length,slowRoads:summaries.filter(r=>r.level==='slow').length,totalRoads:network.roads.length},signals:Object.fromEntries(Object.entries(network.signals).map(([id])=>[id,effectivePhase(id)])),conditions:{...weather(),weather:settings.weather,timeOfDay:settings.timeOfDay,signalMode:settings.signalMode,compliance:settings.compliance},eventCount:events.length,...(options.includeEvents===false?{}:{events:events.map(event=>({...event}))})};
  }
  return{
    step(dt=FIXED_STEP){if(!finite(dt,0,60))throw new Error('模拟步长应为 0 至 60 秒');remainder+=dt;while(remainder>=FIXED_STEP-1e-10){fixedStep();remainder-=FIXED_STEP;}},snapshot,
    updateSettings(partial){
      settings=checkedSettings({...settings,...partial,speeds:{...settings.speeds,...partial.speeds}});
      for(const car of cars){
        car.compliant=compliant(car.id);
        if(partial.compliance===100&&partial.violation===0){
          const previousViolation=car.violation;car.violation=null;car.eventQueue=car.eventQueue.filter(event=>event.name==='breakdown');
          if(!car.turn)car.unsafePermit=null;
          if(!car.incidentId&&car.event!=='breakdown'){car.event=car.eventQueue[0]?.name??null;car.eventStarted=false;}
          if(previousViolation)log('behavior-reset',{vehicleId:car.id,previousViolation,reason:'all-obey'});
        }
      }
      log('settings',{settings:clone(settings)});
    },
    injectIncident,clearIncident:id=>clearIncident(id,'manual'),clearIncidents(){const ids=incidents.map(incident=>incident.id);for(const id of ids)clearIncident(id,'manual');return ids.length;},
  };
}
