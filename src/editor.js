import {addRoadPath,addRoundabout,placeEndpoint,removeEndpoint,placeFacility,removeAt,removeFacility,demolitionSegment,removeRoadSegment,roundaboutMinRadius} from './network.mjs';
import {sampleCurve,sampleCircle,projectOnRoad,pathLength} from './geometry.mjs';
import {roadWidth} from './lanes.mjs';
import {junctionIssues} from './junction-layout.mjs';
import {terminalIds,terminalLabel} from './terminals.mjs';

const distance=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
const same=(a,b)=>a&&b&&distance(a,b)<.2;
function checkedRoadLayout(network){const issue=junctionIssues(network)[0];if(issue)throw new Error(`${issue.message}。请延长相邻道路或减少车道。`);return network;}

export function pickRoad(network,point,radius=8,surface=false){
  let best=null;
  for(const road of network.roads){const hit=projectOnRoad(network,road,point),reach=surface?Math.max(radius,roadWidth(road)/2):radius;if(hit.distance<reach&&(!best||hit.distance<best.distance))best={road,...hit};}
  return best;
}
export function pickNode(network,point,radius=8){return network.nodes.filter(n=>distance(n,point)<radius).sort((a,b)=>distance(a,point)-distance(b,point))[0]||null;}
export function pickFacility(network,point,radius=5){return(network.facilities||[]).filter(f=>distance(f,point)<radius).sort((a,b)=>distance(a,point)-distance(b,point))[0]||null;}

function simplify(points,tolerance=1){
  if(points.length<3)return points;
  const first=points[0],last=points.at(-1),dx=last.x-first.x,dz=last.z-first.z,l2=dx*dx+dz*dz;
  let max=0,index=0;
  for(let i=1;i<points.length-1;i++){const p=points[i],t=l2?Math.max(0,Math.min(1,((p.x-first.x)*dx+(p.z-first.z)*dz)/l2)):0;const d=Math.hypot(p.x-first.x-t*dx,p.z-first.z-t*dz);if(d>max){max=d;index=i;}}
  return max>tolerance?[...simplify(points.slice(0,index+1),tolerance).slice(0,-1),...simplify(points.slice(index),tolerance)]:[first,last];
}
function smoothFree(points){
  let p=simplify(points,.8);if(p.length<3)return p;
  for(let pass=0;pass<2;pass++){const next=[p[0]];for(let i=0;i<p.length-1;i++){const a=p[i],b=p[i+1];next.push({x:a.x*.75+b.x*.25,z:a.z*.75+b.z*.25},{x:a.x*.25+b.x*.75,z:a.z*.25+b.z*.75});}next.push(p.at(-1));p=next;}
  return p;
}

export class RoadEditor{
  constructor({view,getState,commit,changed,toast,selectRoad,selectNode,selectFacility,selectVehicle,selectIncident,hint}){
    Object.assign(this,{view,getState,commit,changed,toast,selectRoad,selectNode,selectFacility,selectVehicle,selectIncident,hint});
    this.points=[];this.pointer=null;this.touches=new Map();this.gesture=null;this.preview=[];this.validationAt=0;this.validationMessage='';
    const canvas=view.canvas;
    canvas.addEventListener('pointerdown',e=>this.down(e));canvas.addEventListener('pointermove',e=>this.move(e));canvas.addEventListener('pointerup',e=>this.up(e));
    canvas.addEventListener('pointercancel',()=>this.cancel(true));canvas.addEventListener('pointerleave',()=>{if(!this.pointer)this.view.setHover?.(null);});canvas.addEventListener('contextmenu',e=>{e.preventDefault();});
    canvas.addEventListener('wheel',e=>{const s=getState();if(s.mode==='edit'&&s.editView!=='3d'){e.preventDefault();view.zoom(e.deltaY>0?1.08:.925);}},{passive:false});
  }
  get state(){return this.getState();}
  point(e,snap=true){
    let p=this.view.worldAt(e.clientX,e.clientY,true);const s=this.state;if(!snap)return p;
    const radius=this.worldRadius(13);
    if(s.snapNodes!==false){const n=pickNode(s.network,p,radius);if(n)return{x:n.x,z:n.z,snap:'node'};}
    if(s.snapRoads!==false){const r=pickRoad(s.network,p,radius*.65);if(r)return{x:r.x,z:r.z,snap:'road'};}
    if(s.snapGrid)p={x:Math.round(p.x/5)*5,z:Math.round(p.z/5)*5};
    const anchor=this.points[0];if(anchor&&(s.snapAngles||e.shiftKey)&&s.shape==='straight'){const a=Math.atan2(p.z-anchor.z,p.x-anchor.x),step=(e.shiftKey?45:15)*Math.PI/180,len=distance(anchor,p),angle=Math.round(a/step)*step;p={x:anchor.x+Math.cos(angle)*len,z:anchor.z+Math.sin(angle)*len,snap:'angle'};}
    return p;
  }
  worldRadius(pixels){const r=this.view.canvas.getBoundingClientRect(),a=this.view.worldAt(r.left+r.width/2,r.top+r.height/2,true),b=this.view.worldAt(r.left+r.width/2+pixels,r.top+r.height/2,true);return Math.max(1,Math.min(15,distance(a,b)));}
  setTool(tool){this.cancel(true);this.state.tool=tool;this.changed();this.defaultHint();}
  setShape(shape){this.cancel(true);this.state.shape=shape;this.state.tool='road';this.changed();this.defaultHint();}
  cancel(all=false){clearTimeout(this.validationTimer);this.pointer=null;this.touches.clear();this.gesture=null;this.validationAt=0;this.validationMessage='';if(all)this.points=[];else this.points.pop();this.state.anchor=this.points[0]||null;this.view.setPreview([]);this.view.setHover?.(null);this.changed();this.defaultHint();}
  defaultHint(){
    const s=this.state;
    const issue=s.tool==='select'&&junctionIssues(s.network)[0];
    if(issue){this.hint?.({title:'调整路口空间',detail:`${issue.message}。延长相邻道路或减少车道后可运行。`,valid:false});return;}
    const messages={select:['选择与检查',s.editView==='3d'?'左键拖动旋转视角，单击道路、设施或车辆查看属性':'点击道路、设施或车辆查看属性'],source:['添加入口','可重复放置；每个入口连接一条单向道路'],sink:['添加出口','可重复放置；每个出口连接一条单向道路'],erase:['局部拆除','点击端口移除标识；道路预览约 32 米；Ctrl Z 撤销'],facility:['布置设施','点击道路旁放置；信号灯会吸附到路口']};
    let text=messages[s.tool]||['绘制道路','点击或拖动完成道路'];
    if(s.tool==='road')text=({straight:['直线道路',this.points.length?'点击终点，连续建造；右键返回':'点击起点或按住拖动；Shift 锁定 45°'],curve:['曲线道路',['点击道路起点','点击弯曲控制点','点击道路终点，完成曲线'][Math.min(2,this.points.length)]],free:['自由道路','按住拖动绘制，松开完成平滑道路'],circle:['圆形道路',this.points.length?`点击确定半径，最小 ${roundaboutMinRadius({oneWay:!!s.newOneWay,lanesForward:s.newLanesForward??1,lanesBackward:s.newLanesBackward??1,turnsForward:s.newTurnsForward,turnsBackward:s.newTurnsBackward}).toFixed(1)} 米`:'点击圆心，再确定半径；也可按住拖动']})[s.shape||'straight'];
    this.hint?.({title:text[0],detail:text[1],valid:true});
  }
  showPreview(point){
    const s=this.state;let points=[],detail='',valid=true;
    if(s.tool==='road'){
      if(!this.points.length){this.view.setHover?.({point,valid:true});this.defaultHint();return;}
      if(s.shape==='circle'){const radius=distance(this.points[0],point),minimum=roundaboutMinRadius({oneWay:!!s.newOneWay,lanesForward:s.newLanesForward??1,lanesBackward:s.newLanesBackward??1,turnsForward:s.newTurnsForward,turnsBackward:s.newTurnsBackward});points=sampleCircle(this.points[0],radius,96);valid=radius>=minimum;detail=`半径 ${radius.toFixed(1)} 米 · 周长 ${(radius*Math.PI*2).toFixed(1)} 米`;}
      else if(s.shape==='curve'&&this.points.length>=2){points=sampleCurve(this.points[0],this.points[1],point,64);detail=`曲线长 ${pathLength(points).toFixed(1)} 米 · 点击完成`;valid=pathLength(points)>=25;}
      else if(s.shape==='free'&&this.pointer?.moved){points=smoothFree(this.pointer.stroke);detail=`道路长 ${pathLength(points).toFixed(1)} 米 · 松开完成`;valid=pathLength(points)>=25;}
      else{points=[this.points[0],point];const len=distance(...points),angle=Math.atan2(point.z-points[0].z,point.x-points[0].x)*180/Math.PI;detail=`长度 ${len.toFixed(1)} 米 · 方向 ${Math.abs(angle).toFixed(0)}°${point.snap?' · 已吸附':''}`;valid=s.shape==='curve'||len>=25;}
      const complete=s.shape!=='curve'||this.points.length>=2;
      clearTimeout(this.validationTimer);
      if(valid&&complete&&performance.now()-this.validationAt>90){this.validationAt=performance.now();this.validationMessage='';try{if(s.shape==='circle')checkedRoadLayout(addRoundabout(s.network,this.points[0],distance(this.points[0],point),{oneWay:!!s.newOneWay,lanesForward:s.newLanesForward??1,lanesBackward:s.newLanesBackward??1,turnsForward:s.newTurnsForward,turnsBackward:s.newTurnsBackward}));else checkedRoadLayout(addRoadPath(s.network,points,{shape:s.shape||'straight',type:s.newRoadType||'local',speedLimit:s.newRoadSpeed||50,oneWay:!!s.newOneWay,width:s.roadWidth||9.6,lanesForward:s.newLanesForward??1,lanesBackward:s.newLanesBackward??1,turnsForward:s.newTurnsForward,turnsBackward:s.newTurnsBackward}));}catch(error){this.validationMessage=error.message;}}
      else if(valid&&complete){const anchors=this.points;this.validationTimer=setTimeout(()=>{if(this.points===anchors&&this.state.mode==='edit'&&this.state.tool==='road')this.showPreview(point);},100);}
      if(valid&&complete&&this.validationMessage){valid=false;detail=this.validationMessage;}
      this.preview=points;this.view.setPreview(points,{valid,width:s.roadWidth||9.6,lanesForward:s.newLanesForward??1,lanesBackward:s.newLanesBackward??1,turnsForward:s.newTurnsForward,turnsBackward:s.newTurnsBackward,controlPoints:this.points});this.hint?.({title:valid?'预览有效':'暂时无法建造',detail,valid});
    }else if(s.tool==='facility'){this.view.setHover?.({point,facilityType:s.facilityType||'streetlight',valid:!!pickRoad(s.network,point,18)});}
    else if(s.tool==='select'||s.tool==='erase'){
      const port=s.tool==='erase'&&pickNode(s.network,point,this.worldRadius(5)),kind=port&&(terminalIds(s.network,'source').includes(port.id)?'source':terminalIds(s.network,'sink').includes(port.id)?'sink':null);
      if(kind){this.view.setHover?.({point:port,erase:true});this.hint?.({title:'移除端口',detail:`点击移除${terminalLabel(s.network,kind,port.id)}，Ctrl Z 撤销`,valid:true});return;}
      const f=pickFacility(s.network,point,this.worldRadius(12)),r=pickRoad(s.network,point,this.worldRadius(10),true),segment=s.tool==='erase'&&!f&&r?demolitionSegment(s.network,r.road.id,r.s):null;
      this.view.setHover?.({point,roadId:f?null:r?.road.id,segmentPoints:segment?.points,facilityId:f?.id,erase:s.tool==='erase'});
      if(segment)this.hint?.({title:'局部拆除预览',detail:`本次删除 ${segment.length.toFixed(1)} 米；点击确认，Ctrl Z 撤销`,valid:true});else this.defaultHint();
    }
    else if(s.tool==='source'||s.tool==='sink'){
      const node=pickNode(s.network,point,.2),road=pickRoad(s.network,point,.2),degree=node?s.network.roads.filter(r=>r.a===node.id||r.b===node.id).length:0,others=terminalIds(s.network,s.tool==='source'?'sink':'source');
      const valid=degree<=1&&(!road||!!node)&&!others.includes(node?.id);
      this.view.setHover?.({point,valid});this.hint?.({title:valid?(s.tool==='source'?'单向入口':'单向出口'):'此处无法放置端口',detail:valid?'端口仅连接一条道路，连接后固定车辆通行方向':'请选择空地或仅连接一条道路的端点',valid});
    }else this.view.setHover?.({point,valid:true});
  }
  down(e){
    if(!['edit','run'].includes(this.state.mode)||this.state.panel)return;
    this.touches.set(e.pointerId,{x:e.clientX,y:e.clientY});this.view.canvas.setPointerCapture(e.pointerId);
    if(this.touches.size===2&&this.state.mode==='edit'){const[a,b]=[...this.touches.values()];this.gesture={distance:Math.hypot(a.x-b.x,a.y-b.y),x:(a.x+b.x)/2,y:(a.y+b.y)/2};this.pointer=null;return;}
    const point=this.point(e);this.pointer={id:e.pointerId,x:e.clientX,y:e.clientY,button:e.button,start:point,lastWorld:this.point(e,false),moved:false,stroke:[point]};
    if(e.button===0&&this.state.mode==='edit'&&this.state.tool==='road'&&!this.points.length){this.points=[point];this.state.anchor=point;this.pointer.started=true;}
  }
  move(e){
    const s=this.state;if(!['edit','run'].includes(s.mode)||s.panel)return;
    if(this.touches.has(e.pointerId))this.touches.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(this.gesture&&this.touches.size===2){const[a,b]=[...this.touches.values()],len=Math.hypot(a.x-b.x,a.y-b.y),x=(a.x+b.x)/2,y=(a.y+b.y)/2;this.view.zoom(this.gesture.distance/Math.max(1,len));const old=this.view.worldAt(this.gesture.x,this.gesture.y,true),next=this.view.worldAt(x,y,true);this.view.pan(old.x-next.x,old.z-next.z);this.gesture={distance:len,x,y};return;}
    const point=this.point(e,s.tool!=='erase'),p=this.pointer;
    if(p){if(Math.hypot(e.clientX-p.x,e.clientY-p.y)>5)p.moved=true;if(p.button===1&&s.editView!=='3d'&&s.mode==='edit'){const next=this.point(e,false);this.view.pan(p.lastWorld.x-next.x,p.lastWorld.z-next.z);p.lastWorld=this.point(e,false);return;}if(p.moved&&s.tool==='road'&&s.shape==='free'&&distance(p.stroke.at(-1),point)>1.5)p.stroke.push(point);}
    if(s.mode==='edit'&&s.editView==='3d'&&s.tool==='select'&&p?.moved){this.view.setHover?.(null);return;}if(s.mode==='edit')this.showPreview(point);
  }
  up(e){
    clearTimeout(this.validationTimer);
    this.touches.delete(e.pointerId);if(this.gesture){if(!this.touches.size)this.gesture=null;this.pointer=null;return;}
    const p=this.pointer;this.pointer=null;if(!p||this.state.panel)return;
    if(p.button===2){if(!p.moved)this.cancel();return;}if(p.button!==0)return;
    const s=this.state,point=this.point(e,this.state.tool!=='erase');
    if(s.mode==='run'){if(!p.moved)this.inspect(this.point(e,false),true);return;}
    if(s.mode!=='edit')return;
    try{
      if(s.tool==='select'){if(!p.moved)this.inspect(point);}
      else if(s.tool==='source'||s.tool==='sink'){
        const kind=s.tool;this.commit(placeEndpoint(s.network,kind,point));this.points=[];
        if(kind==='source'){const placed=pickNode(s.network,point,.2)?.id,connected=s.network.roads.some(r=>r.a===placed||r.b===placed);s.tool=connected?'select':'road';this.points=connected?[]:[point];s.anchor=this.points[0]||null;}else{s.tool='select';s.anchor=null;this.toast('出口已添加，可继续添加端口或开始运行');}this.changed();
      }else if(s.tool==='facility'){this.commit(placeFacility(s.network,{type:s.facilityType||'streetlight',point,side:e.altKey?-1:s.facilitySide||1}));this.toast('设施已安装');}
      else if(s.tool==='erase'){
        const f=pickFacility(s.network,point,this.worldRadius(12));if(f)this.commit(removeFacility(s.network,f.id));else{const n=pickNode(s.network,point,this.worldRadius(5)),kind=n&&(terminalIds(s.network,'source').includes(n.id)?'source':terminalIds(s.network,'sink').includes(n.id)?'sink':null),r=pickRoad(s.network,point,this.worldRadius(10),true);if(kind){const label=terminalLabel(s.network,kind,n.id);this.commit(removeEndpoint(s.network,kind,n.id));this.toast(`已移除${label}`);}else if(r){const segment=demolitionSegment(s.network,r.road.id,r.s);this.commit(removeRoadSegment(s.network,{roadId:r.road.id,s:r.s}));this.toast(`已拆除 ${segment.length.toFixed(1)} 米道路`);}else if(n&&s.network.roads.every(road=>road.a!==n.id&&road.b!==n.id))this.commit(removeAt(s.network,{nodeId:n.id}));}
      }else if(s.tool==='road'){
        const shape=s.shape||'straight',circleMinimum=roundaboutMinRadius({oneWay:!!s.newOneWay,lanesForward:s.newLanesForward??1,lanesBackward:s.newLanesBackward??1,turnsForward:s.newTurnsForward,turnsBackward:s.newTurnsBackward});let path=null;
        if(shape==='circle'){
          if((p.moved||!p.started)&&distance(this.points[0],point)>=circleMinimum){this.commit(checkedRoadLayout(addRoundabout(s.network,this.points[0],distance(this.points[0],point),{oneWay:!!s.newOneWay,lanesForward:s.newLanesForward??1,lanesBackward:s.newLanesBackward??1,turnsForward:s.newTurnsForward,turnsBackward:s.newTurnsBackward})));this.points=[];this.toast('圆形道路已建造，可连接入口和出口');}
          else if(!p.started&&distance(this.points[0],point)<circleMinimum)throw new Error(`当前车道配置的圆形道路半径至少为 ${circleMinimum.toFixed(1)} 米`);
        }else if(shape==='free'){
          if(p.moved){path=smoothFree(p.stroke);if(!same(path.at(-1),point))path.push(point);}else if(!p.started)path=[this.points[0],point];
        }else if(shape==='curve'){
          if(!p.started){if(this.points.length===1)this.points.push(point);else path=sampleCurve(this.points[0],this.points[1],point,64);}
        }else if(p.moved||!p.started){if(distance(this.points[0],point)>=25)path=[this.points[0],point];else if(!p.started)throw new Error('道路长度至少为 25 米');}
        if(path){this.commit(checkedRoadLayout(addRoadPath(s.network,path,{shape,type:s.newRoadType||'local',speedLimit:s.newRoadSpeed||50,oneWay:!!s.newOneWay,width:s.roadWidth||9.6,lanesForward:s.newLanesForward??1,lanesBackward:s.newLanesBackward??1,turnsForward:s.newTurnsForward,turnsBackward:s.newTurnsBackward})));const endNode=pickNode(s.network,point,.2),atTerminal=endNode&&[...terminalIds(s.network,'source'),...terminalIds(s.network,'sink')].includes(endNode.id);this.points=shape==='straight'&&!atTerminal?[point]:[];s.anchor=this.points[0]||null;}
      }
      this.view.setPreview([]);this.defaultHint();this.changed();
    }catch(error){this.toast(error.message,true);this.view.setPreview(this.preview,{valid:false,width:s.roadWidth||9.6,lanesForward:s.newLanesForward??1,lanesBackward:s.newLanesBackward??1,turnsForward:s.newTurnsForward,turnsBackward:s.newTurnsBackward,controlPoints:this.points});this.hint?.({title:'暂时无法建造',detail:error.message,valid:false});}
  }
  inspect(point,running=false){
    const s=this.state,fac=pickFacility(s.network,point,this.worldRadius(10));
    if(running){const snap=s.simulation?.snapshot({includeEvents:false});const incident=snap?.incidents?.filter(i=>distance(i,point)<this.worldRadius(15)).sort((a,b)=>distance(a,point)-distance(b,point))[0];if(incident){this.selectIncident?.(incident.id);return;}const car=snap?.vehicles?.filter(v=>distance(v,point)<this.worldRadius(10)).sort((a,b)=>distance(a,point)-distance(b,point))[0];if(car){this.selectVehicle?.(car.id);return;}}
    if(fac){this.selectFacility?.(fac.id);return;}const node=pickNode(s.network,point,this.worldRadius(6));if(node&&s.network.roads.filter(r=>r.a===node.id||r.b===node.id).length>=2){this.selectNode?.(node.id);return;}const road=pickRoad(s.network,point,this.worldRadius(10),true);if(road)this.selectRoad?.(road.road.id);
  }
}
