import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VEHICLE_TYPES,junctionConnections } from './simulation.mjs';
import {roadPath,roadPointAt,makePath,pathPointAt} from './geometry.mjs';
import {laneCounts,laneOffset,roadWidth,hasLaneConfiguration,effectiveLaneTurns} from './lanes.mjs';
import {WorldDetails} from './world-details.js';
import {junctionLayout} from './junction-layout.mjs';
import {pavementFootprints,dominantThroughPair} from './junction-design.mjs';
import {terminalIds,terminalLabel} from './terminals.mjs';
import {roadTurnarounds} from './turnarounds.mjs';

export const assetUrl = path => new URL(`./assets/${path}`, document.baseURI).href;
const BG=0xeaf0e8, ROAD=0x1d2428, EDGE=0x405057, AMBER=0xffbd4c, GREEN=0x74edb3;
const mat=(color,other={})=>new THREE.MeshStandardMaterial({color,roughness:.83,...other});
const makeBox=(w,h,d,material)=>new THREE.Mesh(new THREE.BoxGeometry(w,h,d),material);
const materials={road:mat(ROAD),edge:mat(EDGE),line:mat(0xc6c9c5),ground:mat(BG),concrete:mat(0x99a19e),dark:mat(0x16242b),selected:mat(AMBER,{emissive:AMBER,emissiveIntensity:.2})};

export class TrafficScene {
  constructor(host,{onError=()=>{},onReady=()=>{}}={}) {
    this.host=host;this.onError=onError;this.onReady=onReady;this.network={nodes:[],roads:[],signals:{}};this.mode='edit';this.models=new Map();this.vehicles=new Map();this.phaseHeads=[];this.labels=[];this.roadVisuals=new Map();this.ready=false;this.fallback=false;this.selection=null;this.preview=[];this.zoomFactor=1;
    this.canvas=document.createElement('canvas');this.canvas.setAttribute('aria-label','交通沙盒画布');this.canvas.tabIndex=0;host.prepend(this.canvas);
    this.labelLayer=document.createElement('div');this.labelLayer.className='scene-labels';host.append(this.labelLayer);
    this.scene=new THREE.Scene();this.scene.background=new THREE.Color(BG);this.scene.fog=new THREE.Fog(BG,500,1200);
    this.camera=new THREE.PerspectiveCamera(40,1,1,1600);this.camera.position.set(0,230,180);this.camera.lookAt(0,0,0);
    this.editCamera=new THREE.OrthographicCamera(-150,150,100,-100,.1,1000);this.editCamera.position.set(0,300,.001);this.editCamera.up.set(0,0,-1);this.editCamera.lookAt(0,0,0);
    this.currentCamera=this.editCamera;this.center=new THREE.Vector3(0,0,0);this.span=230;
    try{
      this.renderer=new THREE.WebGLRenderer({canvas:this.canvas,antialias:true,alpha:false,powerPreference:'high-performance'});
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,1.75));this.renderer.outputColorSpace=THREE.SRGBColorSpace;this.renderer.toneMapping=THREE.ACESFilmicToneMapping;this.renderer.toneMappingExposure=1.35;
      this.renderer.shadowMap.enabled=true;this.renderer.shadowMap.type=THREE.PCFSoftShadowMap;
      this.controls=new OrbitControls(this.camera,this.canvas);this.controls.enabled=false;this.controls.enableDamping=true;this.controls.dampingFactor=.09;this.controls.maxPolarAngle=Math.PI*.47;this.controls.minDistance=14;this.controls.maxDistance=900;this.controls.target.copy(this.center);this.controls.mouseButtons={LEFT:null,MIDDLE:THREE.MOUSE.PAN,RIGHT:THREE.MOUSE.ROTATE};
      this.canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();this.enableFallback();this.onError('三维环境中断，已保留车流并切换二维兼容模式');});
    }catch{this.enableFallback();this.onError('当前环境使用二维兼容模式');}
    this.hemisphere=new THREE.HemisphereLight(0xcce4f3,0x405565,1.8);this.scene.add(this.hemisphere);
    const key=new THREE.DirectionalLight(0xfff0d6,3.8);key.position.set(-90,150,80);key.castShadow=true;key.shadow.mapSize.set(2048,2048);key.shadow.camera.left=-180;key.shadow.camera.right=180;key.shadow.camera.top=180;key.shadow.camera.bottom=-180;key.shadow.camera.far=500;key.shadow.bias=-.0006;this.scene.add(key);
    this.sun=key;const fill=new THREE.DirectionalLight(0x7cb3cd,1);fill.position.set(70,40,-100);this.scene.add(fill);this.fill=fill;
    const floor=new THREE.Mesh(new THREE.PlaneGeometry(2200,2200),new THREE.MeshBasicMaterial({color:BG,toneMapped:false}));floor.rotation.x=-Math.PI/2;floor.position.y=-.3;this.scene.add(floor);this.floor=floor;
    this.grid=new THREE.GridHelper(1200,120,0xb7cbb9,0xd4e0d0);this.grid.position.y=0;this.grid.material.transparent=true;this.grid.material.opacity=.45;this.grid.material.toneMapped=false;this.scene.add(this.grid);
    this.roadGroup=new THREE.Group();this.carGroup=new THREE.Group();this.previewGroup=new THREE.Group();this.hoverGroup=new THREE.Group();this.garageGroup=new THREE.Group();this.scene.add(this.roadGroup,this.carGroup,this.previewGroup,this.hoverGroup,this.garageGroup);this.garageGroup.visible=false;this.details=new WorldDetails(this.scene,this.models);this.settings={timeOfDay:'day',weather:'clear'};
    const plinth=new THREE.Mesh(new THREE.CylinderGeometry(9.5,10,.35,80),mat(0x2b414e,{metalness:.3}));plinth.position.y=-.03;plinth.receiveShadow=true;this.garageGroup.add(plinth);
    const ring=new THREE.Mesh(new THREE.TorusGeometry(9.2,.035,8,96),mat(0x70848d));ring.rotation.x=Math.PI/2;ring.position.y=.17;this.garageGroup.add(ring);
    new ResizeObserver(()=>this.resize()).observe(host);this.resize();this.loadModels();
  }
  enableFallback(){
    if(this.fallback)return;this.fallback=true;if(this.controls)this.controls.enabled=false;
    this.fallbackCanvas=document.createElement('canvas');this.fallbackCanvas.setAttribute('aria-label','二维交通画布');this.fallbackCanvas.style.position='absolute';this.fallbackCanvas.style.inset='0';this.fallbackCanvas.style.pointerEvents='none';this.host.prepend(this.fallbackCanvas);this.canvas.style.opacity='0';this.fallbackContext=this.fallbackCanvas.getContext('2d');this.resize();
  }
  async loadModels(){
    const loader=new GLTFLoader();const list=[...VEHICLE_TYPES.map(v=>[v.id,`vehicles/${v.id}.glb`]),['signal','props/signal_pole_3light.glb'],['lamp','props/street_lamp.glb']];
    const results=await Promise.allSettled(list.map(async([id,path])=>{
      const gltf=await loader.loadAsync(assetUrl(path));gltf.scene.traverse(n=>{if(n.isMesh){n.castShadow=true;n.receiveShadow=true;}});this.models.set(id,gltf.scene);
    }));
    const failures=results.flatMap((r,i)=>r.status==='rejected'?[list[i][0]]:[]);this.ready=true;
    if(failures.length)this.onError(`模型加载失败：${failures.join('、')}。暂用轮廓显示，可检查资源目录后刷新。`);
    this.clearCars();this.setNetwork(this.network,this.selection);if(this.mode==='garage')this.setGarage(this.garageType||'sedan');this.onReady({failures});
  }
  resize(){
    const beforePortrait=this.width?this.width/this.height<.8:null;const w=Math.max(1,this.host.clientWidth),h=Math.max(1,this.host.clientHeight);this.width=w;this.height=h;
    if(this.renderer)this.renderer.setSize(w,h,false);
    if(this.fallbackCanvas){this.fallbackCanvas.width=w*devicePixelRatio;this.fallbackCanvas.height=h*devicePixelRatio;this.fallbackContext.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);}
    this.camera.aspect=w/h;this.camera.updateProjectionMatrix();this.updateEditCamera();if(beforePortrait!==null&&beforePortrait!==(w/h<.8)&&this.mode==='run')this.fit();if(this.mode==='garage'&&this.garageType)this.setGarage(this.garageType);
  }
  updateEditCamera(){
    const aspect=this.width/this.height,portrait=aspect<.8,edit=this.mode==='edit';
    const dock=document.querySelector(edit?'#editor-bottom':'#runtime-bottom'),hint=document.querySelector('#tool-hint');
    const reserved=edit?Math.max(dock?.offsetHeight||0,portrait?270:225)+(portrait?14:26)+Math.max(60,hint?.offsetHeight||0)+24:175;
    const top=edit?(portrait?70:30):185,availableHeight=Math.max(120,this.height-reserved-top),availableWidth=Math.max(180,this.width-(portrait?28:190));
    const worldWidth=portrait?(this.depth||140):this.span,worldHeight=portrait?this.span:(this.depth||140);
    const scale=Math.max(.08,Math.min(availableWidth/worldWidth,availableHeight/worldHeight)/this.zoomFactor),half=this.height/(2*scale),upX=portrait?-1:0,upZ=portrait?0:-1,offset=(top+availableHeight/2-this.height/2)/scale;
    this.editCamera.left=-half*aspect;this.editCamera.right=half*aspect;this.editCamera.top=half;this.editCamera.bottom=-half;
    this.editCamera.up.set(upX,0,upZ);const cx=this.center.x+upX*offset,cz=this.center.z+upZ*offset;this.editCamera.position.set(cx,300,cz+.001);this.editCamera.lookAt(cx,0,cz);this.editCamera.updateProjectionMatrix();
  }
  fit(){
    const n=[...this.network.nodes,...this.network.roads.flatMap(r=>r.points||[])];if(n.length){const xs=n.map(v=>v.x),zs=n.map(v=>v.z);this.center.set((Math.min(...xs)+Math.max(...xs))/2,0,(Math.min(...zs)+Math.max(...zs))/2);this.span=Math.max(150,Math.max(...xs)-Math.min(...xs)+55);this.depth=Math.max(85,Math.max(...zs)-Math.min(...zs)+50);}else{this.center.set(0,0,0);this.span=240;this.depth=140;}
    this.zoomFactor=1;this.updateEditCamera();const aspect=this.width/this.height,portrait=aspect<.8;const r=Math.max((portrait?this.depth:this.span)/(Math.max(.4,aspect)*.72),(portrait?this.span:this.depth)*1.4)*1.1;this.camera.position.set(this.center.x+r*(portrait?.72:0),r*.78,this.center.z+r*(portrait?0:.72));this.controls?.target.set(this.center.x,portrait?-22:0,this.center.z);this.controls?.update();
  }
  zoom(delta){if((this.mode==='edit'&&!this.editPerspective)||this.fallback){this.zoomFactor=THREE.MathUtils.clamp(this.zoomFactor*delta,.2,4);this.updateEditCamera();}else if(this.controls){this.camera.position.sub(this.controls.target).multiplyScalar(delta).add(this.controls.target);this.controls.update();}}
  pan(dx,dz){this.center.x+=dx;this.center.z+=dz;this.updateEditCamera();if(this.currentCamera===this.camera&&this.controls){this.camera.position.x+=dx;this.camera.position.z+=dz;this.controls.target.x+=dx;this.controls.target.z+=dz;this.controls.update();}}
  worldAt(clientX,clientY,useCurrent=false){const r=this.canvas.getBoundingClientRect(),p=new THREE.Vector2((clientX-r.left)/r.width*2-1,-((clientY-r.top)/r.height)*2+1);const ray=new THREE.Raycaster();ray.setFromCamera(p,useCurrent&&!this.fallback?this.currentCamera:this.editCamera);const hit=new THREE.Vector3();ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0,1,0),0),hit);return{x:hit.x,z:hit.z};}
  project(p){const q=new THREE.Vector3(p.x,p.y??0,p.z).project(this.fallback?this.editCamera:this.currentCamera);return{x:(q.x+1)*this.width/2,y:(1-q.y)*this.height/2,visible:q.z<1};}
  clear(group){while(group.children.length){const c=group.children[0];group.remove(c);c.traverse(n=>{if(n.geometry&&!n.userData.asset)n.geometry.dispose();});}}
  strip(points,width,material,y,group=this.roadGroup){
    const path=makePath(points),vertices=[],indices=[];
    for(let i=0;i<path.points.length;i++){const p=path.points[i],d=path.tangents[i],w=Array.isArray(width)?width[i]:width;vertices.push(p.x-d.dz*w/2,y,p.z+d.dx*w/2,p.x+d.dz*w/2,y,p.z-d.dx*w/2);}
    for(let i=0;i<path.points.length-1;i++)indices.push(i*2,i*2+2,i*2+1,i*2+1,i*2+2,i*2+3);
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));geometry.setIndex(indices);geometry.computeVertexNormals();const mesh=new THREE.Mesh(geometry,material);mesh.receiveShadow=true;group.add(mesh);return mesh;
  }
  pathLine(points,color,y=.48,dashed=false,group=this.roadGroup){const geometry=new THREE.BufferGeometry().setFromPoints(points.map(p=>new THREE.Vector3(p.x,y,p.z)));const material=dashed?new THREE.LineDashedMaterial({color,dashSize:2.8,gapSize:4.2}):new THREE.LineBasicMaterial({color});const line=new THREE.Line(geometry,material);if(dashed)line.computeLineDistances();group.add(line);return line;}
  pavementMesh(polygons,material,y){
    const vertices=[],indices=[];
    for(const points of polygons){if(points.length<3)continue;const start=vertices.length/3;for(const p of points)vertices.push(p.x,y,p.z);for(let i=1;i<points.length-1;i++)indices.push(start,start+i+1,start+i);}
    if(!vertices.length)return;
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));geometry.setIndex(indices);geometry.computeVertexNormals();
    const mesh=new THREE.Mesh(geometry,material);mesh.receiveShadow=true;this.roadGroup.add(mesh);return mesh;
  }
  junctionGuidance(network,layout,connections){
    const offset=(points,width)=>points.map(p=>({x:p.x-Math.cos(p.yaw)*width,z:p.z+Math.sin(p.yaw)*width}));
    const marked=new Set();
    const paint=(connection,main)=>{
      for(const side of[-1,1]){const points=offset(connection.points,side*connection.laneWidth/2),key=points.map((p,i)=>i%12===0?`${p.x.toFixed(2)},${p.z.toFixed(2)}`:'').join(';');if(marked.has(key))continue;marked.add(key);
        const line=this.pathLine(points,main?0xd5dfd4:0xb9cbbb,.50,true);line.material.dashSize=main?2.2:1.4;line.material.gapSize=main?3.8:3.2;line.material.transparent=true;line.material.opacity=main?.78:.58;line.material.depthWrite=false;
      }
    };
    for(const junction of layout.nodes){
      const paths=connections.filter(c=>c.nodeId===junction.nodeId&&!c.uTurn),main=dominantThroughPair(network,junction),branches=new Map();
      for(const c of paths){
        if(main?.roadIds.includes(c.inRoadId)&&main.roadIds.includes(c.outRoadId)){if(c.preferred)paint(c,true);continue;}
        const key=`${c.inRoadId}:${c.outRoadId}`,old=branches.get(key);if(!old||c.length<old.length)branches.set(key,c);
      }
      for(const c of branches.values())paint(c,false);
    }
  }
  turnaroundGuidance(pads,color){
    for(const pad of pads){
      for(const edge of pad.outline)this.pathLine(edge,color,.50);
      const guide=this.pathLine(pad.guide,0xe3e8e1,.51,true);guide.material.dashSize=1.4;guide.material.gapSize=1.2;
      const path=makePath(pad.guide),tip=pathPointAt(path,path.length*.67),dx=tip.tangentX,dz=tip.tangentZ;
      this.pathLine([{x:tip.x-dx*1.4-dz*.8,z:tip.z-dz*1.4+dx*.8},tip,{x:tip.x-dx*1.4+dz*.8,z:tip.z-dz*1.4-dx*.8}],0xe3e8e1,.54);
    }
  }
  batchRoadLines(){
    const groups=new Map();
    for(const line of [...this.roadGroup.children]){
      if(line.type!=='Line')continue;
      const m=line.material,key=[m.type,m.color.getHex(),m.opacity,m.transparent,m.depthWrite,m.dashSize,m.gapSize].join(':'),position=line.geometry.getAttribute('position'),distance=line.geometry.getAttribute('lineDistance');
      let batch=groups.get(key);if(!batch){batch={material:m,positions:[],distances:[]};groups.set(key,batch);}else if(m!==batch.material)m.dispose();
      for(let i=1;i<position.count;i++)for(const j of[i-1,i]){batch.positions.push(position.getX(j),position.getY(j),position.getZ(j));if(distance)batch.distances.push(distance.getX(j));}
      this.roadGroup.remove(line);line.geometry.dispose();
    }
    for(const batch of groups.values()){
      const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(batch.positions,3));if(batch.distances.length)geometry.setAttribute('lineDistance',new THREE.Float32BufferAttribute(batch.distances,1));
      this.roadGroup.add(new THREE.LineSegments(geometry,batch.material));
    }
  }
  laneArrow(network,road,d,offset,forward,turns){const sign=forward?1:-1,at=(s,o=offset)=>roadPointAt(network,road,s,o),tail=at(d-sign*3),center=at(d);for(const turn of turns){if(turn==='through'){const tip=at(d+sign*1.7);this.pathLine([tail,tip],0xdbe4db,.55);this.pathLine([at(d-sign,offset-.9),tip,at(d-sign,offset+.9)],0xdbe4db,.55);}else{const bend=(turn==='left'?-1:1)*sign,tipOffset=offset+bend*2,tip=at(d,tipOffset);this.pathLine([tail,center,tip],0xdbe4db,.55);this.pathLine([at(d-sign*.8,tipOffset-bend*.8),tip,at(d+sign*.8,tipOffset-bend*.8)],0xdbe4db,.55);}}}
  setNetwork(network,selection=null){
    this.network=network;this.selection=selection;this.clear(this.roadGroup);this.phaseHeads=[];this.labelLayer.innerHTML='';this.labels=[];this.roadVisuals.clear();
    const layout=junctionLayout(network),connections=junctionConnections(network);this.junctionGeometry=layout;
    const envelope={vehicleLength:Math.max(...VEHICLE_TYPES.map(v=>v.length)),vehicleWidth:Math.max(...VEHICLE_TYPES.map(v=>v.width)),margin:.65};
    const pavement=pavementFootprints(network,connections,envelope),curbs=pavementFootprints(network,connections,{...envelope,curbMargin:1.35});
    this.pavementMesh(curbs,materials.edge,.25);this.pavementMesh(pavement,materials.road,.43);this.pavementGeometry={polygons:pavement,connections};
    const trim=(road,id)=>layout.byNode.get(id)?.arms.find(a=>a.roadId===road.id)?.trim||0;
    for(const road of network.roads){
      const path=roadPath(network,road),width=roadWidth(road),pads=roadTurnarounds(network,road,connections,envelope);
      const start=Math.max(trim(road,road.a),pads.find(p=>p.end==='a')?.trim||0),end=path.length-Math.max(trim(road,road.b),pads.find(p=>p.end==='b')?.trim||0),steps=Math.max(2,Math.ceil((end-start)/3)),points=[];
      for(let i=0;i<=steps;i++){const p=roadPointAt(network,road,start+(end-start)*i/steps);points.push({x:p.x,z:p.z});}
      const surface=materials.road.clone();
      for(const pad of pads){this.pavementMesh([pad.curbPolygon],materials.edge,.25);this.pavementMesh([pad.polygon],surface,.445);}
      this.turnaroundGuidance(pads,selection===road.id?AMBER:0xbac6c7);
      if(end-start>.05){
        this.strip(points,width,surface,.445);
        for(const side of[-1,1]){const edge=[];for(let i=0;i<=steps;i++)edge.push(roadPointAt(network,road,start+(end-start)*i/steps,side*(width/2-.45)));this.pathLine(edge,selection===road.id?AMBER:0xbac6c7,.48);}
        const counts=laneCounts(road);
        if(hasLaneConfiguration(road)){
          for(let i=1;i<counts.total;i++){const offset=-counts.total*1.8+i*3.6,line=[];for(let j=0;j<=steps;j++)line.push(roadPointAt(network,road,start+(end-start)*j/steps,offset));const divider=!road.oneWay&&i===counts.backward;this.pathLine(line,divider?0xd5bc76:0xe3e8e1,.49,!divider);}
        }else if(!road.oneWay)this.pathLine(points,0xbac6c7,.48,true);
        for(const forward of[true,false]){const count=forward?counts.forward:counts.backward;for(let lane=0;lane<count;lane++)for(let d=start+12;d<end-8;d+=50)this.laneArrow(network,road,d,laneOffset(road,forward,lane),forward,terminalIds(network,'sink').includes(forward?road.b:road.a)?['through']:effectiveLaneTurns(network,road,forward,lane));}
      }
      const ports=new Set([...terminalIds(network,'source'),...terminalIds(network,'sink')]);
      if(road.oneWay)for(const endNode of [road.a,road.b])if(!ports.has(endNode)&&network.roads.filter(r=>r.a===endNode||r.b===endNode).length===1){const s=endNode===road.a?0:path.length;this.pathLine([roadPointAt(network,road,s,-width/2+.45),roadPointAt(network,road,s,width/2-.45)],selection===road.id?AMBER:0xbac6c7,.50);}
      const middle=roadPointAt(network,road,path.length/2);const badge=document.createElement('div');badge.className='road-badge hidden';this.labelLayer.append(badge);this.roadVisuals.set(road.id,{surface,badge,p:{x:middle.x,z:middle.z,y:1},level:null});
    }
    this.junctionGuidance(network,layout,connections);
    for(const node of network.nodes){
      const attached=network.roads.filter(r=>r.a===node.id||r.b===node.id),deg=attached.length;
      if([...terminalIds(network,'source'),...terminalIds(network,'sink')].includes(node.id)){const source=terminalIds(network,'source').includes(node.id),road=attached[0],path=road&&roadPath(network,road),p=road&&roadPointAt(network,road,road.a===node.id?0:path.length);const gate=this.makeGate(source,road?roadWidth(road):9.6,road?Array.from({length:laneCounts(road).forward},(_,i)=>(source?-1:1)*laneOffset(road,true,i)):[0]);gate.position.set(node.x,.4,node.z);gate.rotation.y=p?p.yaw+(road.b===node.id?Math.PI:0):Math.PI/2;this.roadGroup.add(gate);const label=document.createElement('div');label.className=`map-label ${source?'source':'sink'}`;label.textContent=terminalLabel(network,source?'source':'sink',node.id);this.labelLayer.append(label);this.labels.push({el:label,p:{x:node.x,z:node.z,y:8}});
      }else{const marker=new THREE.Mesh(new THREE.CylinderGeometry(.65,.65,.16,18),mat(selection===node.id?AMBER:0x9cb9c6));marker.position.set(node.x,.55,node.z);marker.userData.editorMarker=true;this.roadGroup.add(marker);}
      if(network.signals[node.id]?.enabled){const installed=(network.facilities||[]).filter(f=>f.type==='trafficLight'&&f.nodeId===node.id);const heads=installed.length?installed:[{x:node.x-7.5,z:node.z+5,heading:Math.PI/2},{x:node.x+5,z:node.z-7.5,heading:0}];
        for(const f of heads){const g=this.makeSignal();g.position.set(f.x,.45,f.z);g.rotation.y=f.heading||0;this.roadGroup.add(g);this.phaseHeads.push({nodeId:node.id,axis:Math.abs(Math.sin(f.heading||0))>=Math.abs(Math.cos(f.heading||0))?'ew':'ns',object:g});}
      }
    }
    this.batchRoadLines();this.details.setNetwork(network,selection);this.setModeVisibility();
  }
  setPreview(points,{valid=true,width=9.3,controlPoints=[]}={}){
    this.preview=points;this.clear(this.previewGroup);if(points.length<2)return;
    const color=valid?0x78e7c2:0xff7666;this.strip(points,width,new THREE.MeshBasicMaterial({color,transparent:true,opacity:.24,depthWrite:false,side:THREE.DoubleSide,toneMapped:false}),.65,this.previewGroup);this.pathLine(points,color,.7,true,this.previewGroup);
    const anchors=[points[0],points.at(-1),...controlPoints];for(const p of anchors){const disk=new THREE.Mesh(new THREE.RingGeometry(1.2,1.6,24),new THREE.MeshBasicMaterial({color,side:THREE.DoubleSide,toneMapped:false}));disk.rotation.x=-Math.PI/2;disk.position.set(p.x,.7,p.z);this.previewGroup.add(disk);}
  }
  setHover(item){this.clear(this.hoverGroup);if(!item)return;const color=item.erase?0xdd664c:0x2a9872;if(item.roadId){const road=this.network.roads.find(r=>r.id===item.roadId);if(road){const path=roadPath(this.network,road);this.strip(item.segmentPoints||path.points,roadWidth(road)+.6,new THREE.MeshBasicMaterial({color,transparent:true,opacity:.22,depthWrite:false,toneMapped:false,side:THREE.DoubleSide}),.62,this.hoverGroup);}}
    if(item.point){const disk=new THREE.Mesh(new THREE.RingGeometry(1.1,1.5,32),new THREE.MeshBasicMaterial({color:item.valid===false?0xff7666:color,side:THREE.DoubleSide,toneMapped:false}));disk.rotation.x=-Math.PI/2;disk.position.set(item.point.x,.72,item.point.z);this.hoverGroup.add(disk);if(item.facilityType){const pole=makeBox(.22,item.facilityType==='streetlight'?6:3,.22,new THREE.MeshBasicMaterial({color,transparent:true,opacity:.5}));pole.position.set(item.point.x,item.facilityType==='streetlight'?3:1.5,item.point.z);this.hoverGroup.add(pole);}}
  }
  setEditingPerspective(enabled){this.editPerspective=enabled;this.currentCamera=enabled&&!this.fallback?this.camera:this.editCamera;if(this.controls)this.controls.enabled=enabled&&!this.fallback;this.setNavigationTool(this.navigationTool);this.fit();}
  setNavigationTool(tool='select'){this.navigationTool=tool;if(this.controls)this.controls.mouseButtons={LEFT:this.mode!=='edit'||this.editPerspective&&tool==='select'?THREE.MOUSE.ROTATE:null,MIDDLE:THREE.MOUSE.PAN,RIGHT:THREE.MOUSE.ROTATE};}
  focusPoint(point,distance=38){
    if(!point)return;this.followId=null;if(this.fallback){this.center.set(point.x,0,point.z);this.span=85;this.depth=65;this.zoomFactor=.55;this.updateEditCamera();return;}
    this.camera.position.set(point.x+distance*.65,distance*.82,point.z+distance*.72);this.controls?.target.set(point.x,1,point.z);this.controls?.update();
  }
  followVehicle(id){const car=this.snapshot?.vehicles.find(v=>String(v.id)===String(id));if(!car)return;this.focusPoint(car,25);this.followId=car.id;}
  environment(settings){this.settings={...this.settings,...settings};this.details.environment(this.settings);const night=this.settings.timeOfDay==='night',bg=night?0x0a1723:BG;this.scene.background.setHex(bg);this.floor.material.color.setHex(bg);this.hemisphere.intensity=night?.75:1.8;this.sun.intensity=night?.5:3.2;this.fill.intensity=night?.4:1;const far={clear:1400,rain:900,fog:540,snow:750}[this.settings.weather]||1400;this.scene.fog=new THREE.Fog(bg,160,far);}
  makeGate(source,width=9.6,laneOffsets=[0]){const group=new THREE.Group();const light=mat(source?GREEN:AMBER,{emissive:source?GREEN:AMBER,emissiveIntensity:1.3});for(const x of[-(width/2+.6),width/2+.6]){const post=makeBox(1.15,5.5,3.4,materials.concrete);post.position.set(x,2.75,0);post.castShadow=true;group.add(post);const bar=makeBox(.16,3.8,.28,light);bar.position.set(x*.88,2.7,-.6);group.add(bar);}const top=makeBox(width+2.7,1,3.4,materials.concrete);top.position.y=5.7;top.castShadow=true;group.add(top);for(let z=-1;z<=1;z++){const strip=makeBox(width-1,.06,.12,light);strip.position.set(0,.13,z);group.add(strip);}const direction=source?1:-1;const arrowMaterial=new THREE.MeshBasicMaterial({color:source?0x399b72:0xc28c43,toneMapped:false,side:THREE.DoubleSide});for(const laneX of laneOffsets){const arrowGeometry=new THREE.BufferGeometry();arrowGeometry.setAttribute('position',new THREE.Float32BufferAttribute([laneX-1,.17,5.5,laneX,.17,5.5+direction*2.4,laneX+1,.17,5.5],3));group.add(new THREE.Mesh(arrowGeometry,arrowMaterial));const stem=makeBox(.5,.07,2.6,arrowMaterial);stem.position.set(laneX,.17,5.5-direction*1.2);group.add(stem);}return group;}
  makeSignal(){
    let g=this.models.get('signal')?.clone(true);if(!g){g=new THREE.Group();const post=makeBox(.18,4.8,.18,materials.edge);post.position.y=2.4;g.add(post);const box=makeBox(.7,1.9,.5,materials.dark);box.position.y=4.7;g.add(box);for(const [i,color]of['red','amber','green'].entries()){const mesh=new THREE.Mesh(new THREE.SphereGeometry(.21,12,10),mat(0x333333));mesh.name=`lens_${color}`;mesh.position.set(0,5.25-i*.55,.28);g.add(mesh);}}
    g.traverse(n=>{if(n.isMesh){n.userData.asset=true;n.material=n.material.clone();}});return g;
  }
  setModeVisibility(){this.roadGroup.visible=this.mode!=='garage';this.carGroup.visible=this.mode==='run';this.garageGroup.visible=this.mode==='garage';this.previewGroup.visible=this.mode==='edit';this.hoverGroup.visible=this.mode==='edit';this.grid.visible=this.mode!=='garage';this.labelLayer.style.display=this.mode==='garage'?'none':'';this.details.visible(this.mode);this.roadGroup.traverse(n=>{if(n.userData.editorMarker)n.visible=this.mode==='edit';});for(const v of this.roadVisuals.values())if(this.mode!=='run'){v.badge.classList.add('hidden');v.surface.color.setHex(ROAD);v.level=null;}}
  setMode(mode){this.mode=mode;this.currentCamera=mode==='edit'&&!this.editPerspective?this.editCamera:this.camera;this.controls&&(this.controls.enabled=(mode!=='edit'||this.editPerspective)&&!this.fallback);this.setNavigationTool(this.navigationTool);this.setModeVisibility();if(mode==='run')this.fit();if(mode==='edit'){this.clearCars();this.details.reset();this.fit();}}
  async transitionToRun(){this.mode='transition';this.currentCamera=this.camera;this.setModeVisibility();this.fit();const end=this.camera.position.clone(),start=new THREE.Vector3(this.center.x,Math.max(160,end.y*1.3),this.center.z+.05);const duration=matchMedia('(prefers-reduced-motion: reduce)').matches?0:750;const t0=performance.now();await new Promise(resolve=>{const step=t=>{const ratio=duration?Math.min(1,(t-t0)/duration):1;const eased=ratio*ratio*(3-2*ratio);this.camera.position.lerpVectors(start,end,eased);this.camera.lookAt(this.center);if(ratio<1)requestAnimationFrame(step);else resolve();};requestAnimationFrame(step);});this.setMode('run');}
  clearCars(){for(const model of this.vehicles.values())this.carGroup.remove(model);this.vehicles.clear();}
  carModel(typeId){const source=this.models.get(typeId);const group=new THREE.Group(),t=VEHICLE_TYPES.find(v=>v.id===typeId);if(source){const root=source.clone(true);root.traverse(n=>{if(n.isMesh){n.userData.asset=true;if(/brake|tail|indicator|signal/i.test(n.name)){n.material=n.material.clone();n.userData.dynamicLamp=true;}}});group.add(root);}else{const body=makeBox(t.width,t.height,t.length,mat(t.color));body.position.y=t.height/2;group.add(body);}const queueHalo=makeBox(t.width+.9,.025,t.length+.65,new THREE.MeshBasicMaterial({color:0xff755d,transparent:true,opacity:.6,depthWrite:false,toneMapped:false}));queueHalo.position.y=.08;queueHalo.visible=false;group.userData.queueHalo=queueHalo;group.add(queueHalo);return group;}
  update(snapshot){
    this.snapshot=snapshot;if(!snapshot)return;const live=new Set(snapshot.vehicles.map(v=>v.id));for(const[id,model]of this.vehicles)if(!live.has(id)){this.carGroup.remove(model);this.vehicles.delete(id);}
    if(this.followId!==undefined&&this.followId!==null&&this.controls){const car=snapshot.vehicles.find(v=>v.id===this.followId);if(car){const dx=car.x-this.controls.target.x,dz=car.z-this.controls.target.z;this.camera.position.x+=dx;this.camera.position.z+=dz;this.controls.target.set(car.x,1,car.z);}else this.followId=null;}
    for(const car of snapshot.vehicles){let model=this.vehicles.get(car.id);if(!model){model=this.carModel(car.typeId);this.carGroup.add(model);this.vehicles.set(car.id,model);}model.position.set(car.x,.46,car.z);model.rotation.y=car.yaw;if(model.userData.queueHalo)model.userData.queueHalo.visible=car.speed<1&&snapshot.roadStats?.[car.laneId?.split(':')[0]]?.level==='congested';model.traverse(n=>{if(/^Wheel_/.test(n.name))n.rotation.x=car.distance/.36;if(/^Steer_/.test(n.name))n.rotation.y=car.steeringAngle||0;if(n.isMesh&&n.userData.dynamicLamp&&n.material.emissive){n.material.emissiveIntensity=car.braking?1.4:.12;if(/brake|tail/i.test(n.name))n.material.emissive.setHex(0xff3222);}});}
    for(const head of this.phaseHeads){const phase=snapshot.conditions?.signalMode==='off'?'off':snapshot.signals[head.nodeId]?.[head.axis]||'red';head.object.traverse(n=>{if(!n.isMesh)return;for(const c of['red','amber','green'])if(n.name.includes(`lens_${c}`)){const on=(phase==='yellow'?'amber':phase)===c;n.material.color.setHex(on?({red:0xff3f25,amber:AMBER,green:GREEN}[c]):0x263039);n.material.emissive?.setHex(on?({red:0xff3f25,amber:AMBER,green:GREEN}[c]):0);n.material.emissiveIntensity=on?2:0;}});}
    this.updateTraffic(snapshot.roadStats||{});this.details.update(snapshot,this.center);
  }
  updateTraffic(roads){
    const surfaces={empty:ROAD,free:0x203c34,slow:0x5c4925,congested:0x652b27};
    const crowded=Object.values(roads).filter(r=>r.level==='congested'||r.level==='slow').sort((a,b)=>b.queuedVehicles-a.queuedVehicles||a.speedRatio-b.speedRatio).slice(0,this.width<600?2:4);const visible=new Set(crowded.map(r=>r.roadId));
    for(const[id,v]of this.roadVisuals){const r=roads[id],level=r?.level||'empty';if(v.level!==level||v.heatmap!==this.showHeatmap){v.level=level;v.heatmap=this.showHeatmap;v.surface.color.setHex(this.showHeatmap===false?ROAD:surfaces[level]);}
      v.badge.classList.toggle('hidden',!visible.has(id)||this.mode!=='run');v.badge.dataset.level=level;if(r)v.badge.textContent=`${r.label} · ${r.queuedVehicles?`排队 ${r.queuedVehicles} 辆`:r.meanSpeedKmh==null?'无车':`${r.meanSpeedKmh.toFixed(0)} km/h`}`;
    }
  }
  setGarage(typeId){this.mode='garage';this.garageType=typeId;this.currentCamera=this.camera;this.setModeVisibility();if(this.garageCar)this.garageGroup.remove(this.garageCar);this.garageCar=this.carModel(typeId);this.garageCar.position.y=.2;this.garageGroup.add(this.garageCar);const t=VEHICLE_TYPES.find(v=>v.id===typeId),d=Math.max(7.8,t.length*1.2)*Math.max(1,1/(this.width/this.height));this.camera.position.set(d*.72,d*.36,d*.82);if(this.controls){this.controls.target.set(0,t.height*.8,0);this.controls.enabled=!this.fallback;this.controls.minDistance=5;this.controls.mouseButtons={LEFT:THREE.MOUSE.ROTATE,MIDDLE:THREE.MOUSE.PAN,RIGHT:THREE.MOUSE.ROTATE};this.controls.update();}}
  positionLabels(){const mobile=this.width<600&&this.mode==='run',rail=document.querySelector('#command-rail'),railBox=rail?.getBoundingClientRect(),canvasBox=this.canvas.getBoundingClientRect();for(const label of this.labels){const p=this.project(label.p),source=label.el.classList.contains('source'),right=!mobile&&railBox?.width&&!rail.classList.contains('hidden')&&p.y>railBox.top-canvasBox.top-20&&p.y<railBox.bottom-canvasBox.top+20?railBox.left-canvasBox.left-36:this.width-30;label.el.style.left=`${mobile&&source?Math.max(36,p.x-68):Math.max(30,Math.min(right,p.x))}px`;label.el.style.top=`${mobile?Math.max(240,Math.min(this.height-250,source?p.y+7:p.y-17)):p.y-17}px`;label.el.style.visibility=p.visible?'visible':'hidden';}for(const v of this.roadVisuals.values()){const p=this.project(v.p);v.badge.style.left=`${mobile?Math.max(85,Math.min(this.width-85,p.x-20)):p.x}px`;v.badge.style.top=`${p.y+(mobile?40:-22)}px`;v.badge.style.visibility=p.visible&&p.x>-15&&p.x<this.width+15&&p.y>0&&p.y<this.height?'visible':'hidden';}}
  render(){if(this.fallback){this.renderFallback();return;}if(this.mode==='run'||this.mode==='garage'||this.editPerspective)this.controls?.update();this.renderer.render(this.scene,this.currentCamera);this.positionLabels();}
  renderFallback(){
    const ctx=this.fallbackContext;if(!ctx)return;const w=this.width,h=this.height;ctx.fillStyle='#142731';ctx.fillRect(0,0,w,h);const scale=w/(this.editCamera.right-this.editCamera.left);const drawPath=(a,b,color,width)=>{ctx.strokeStyle=color;ctx.lineWidth=width;ctx.lineCap='round';ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();};
    for(let x=-600;x<=600;x+=10)drawPath(this.project({x,z:-600}),this.project({x,z:600}),'#29434f',.6);for(let z=-600;z<=600;z+=10)drawPath(this.project({x:-600,z}),this.project({x:600,z}),'#29434f',.6);
    const byId=Object.fromEntries(this.network.nodes.map(n=>[n.id,n]));for(const r of this.network.roads){const path=roadPath(this.network,r);const level=this.mode==='run'?this.snapshot?.roadStats?.[r.id]?.level:null;const color={free:'#285345',slow:'#79602c',congested:'#943d34'}[level]||'#35434b';for(let i=1;i<path.points.length;i++){const a=this.project(path.points[i-1]),b=this.project(path.points[i]);drawPath(a,b,r.id===this.selection?'#ffbd4c':'#7d8b8d',((r.width||9.3)+1)*scale);drawPath(a,b,color,(r.width||9.3)*scale);}ctx.setLineDash([]);}
    for(const n of this.network.nodes){const p=this.project(n);ctx.fillStyle=terminalIds(this.network,'source').includes(n.id)?'#74edb3':terminalIds(this.network,'sink').includes(n.id)?'#ffbd4c':'#c0cdcf';ctx.beginPath();ctx.arc(p.x,p.y,Math.max(3,1.2*scale),0,Math.PI*2);ctx.fill();}
    if(this.mode==='run')for(const v of this.snapshot?.vehicles||[]){const p=this.project(v),t=VEHICLE_TYPES.find(t=>t.id===v.typeId);ctx.save();ctx.translate(p.x,p.y);ctx.rotate(-v.yaw);ctx.fillStyle=t.color;ctx.fillRect(-t.width*scale/2,-t.length*scale/2,t.width*scale,t.length*scale);ctx.restore();}
    for(let i=1;i<this.preview.length;i++)drawPath(this.project(this.preview[i-1]),this.project(this.preview[i]),'#ffbd4c',2);
    if(this.mode==='garage'){ctx.fillStyle='#142731';ctx.fillRect(0,0,w,h);if(!this.garageImage||this.garageImage.dataset.id!==this.garageType){this.garageImage=new Image();this.garageImage.dataset.id=this.garageType;this.garageImage.src=assetUrl(`previews/${this.garageType}.png`);}const image=this.garageImage;if(image.complete&&image.naturalWidth){const width=Math.min(w*.9,650),height=width*image.height/image.width;ctx.drawImage(image,(w-width)/2,(h-height)/2-30,width,height);}}
    for(const item of this.mode==='run'?this.snapshot?.incidents||[]:[]){const q=this.project(item);ctx.fillStyle='#ef7664';ctx.font='bold 22px sans-serif';ctx.fillText('⚠',q.x,q.y);}
    this.positionLabels();
  }
}
