import * as THREE from 'three';
import {roadPath,roadPointAt} from './geometry.mjs';
import {streetlightLayout} from './road-facilities.mjs';

const material=(color,extra={})=>new THREE.MeshStandardMaterial({color,roughness:.75,...extra});
const box=(x,y,z,m)=>new THREE.Mesh(new THREE.BoxGeometry(x,y,z),m);
function shared(mesh){mesh.userData.asset=true;return mesh;}
function clear(group){for(const child of [...group.children]){group.remove(child);child.traverse(n=>{if(n.geometry&&!n.userData.asset)n.geometry.dispose();if(n.material&&!n.userData.asset){for(const m of Array.isArray(n.material)?n.material:[n.material])m.dispose();}});}}

export class WorldDetails{
  constructor(scene,models){
    this.scene=scene;this.models=models;this.facilities=new THREE.Group();this.incidentGroup=new THREE.Group();this.weatherGroup=new THREE.Group();
    scene.add(this.facilities,this.incidentGroup,this.weatherGroup);this.incidents=new Map();this.lampMaterials=[];this.lights=[];this.settings={timeOfDay:'day',weather:'clear'};
    this.dropGeometry=new THREE.BufferGeometry();this.dropPositions=new Float32Array(180*6);this.dropGeometry.setAttribute('position',new THREE.BufferAttribute(this.dropPositions,3));this.rain=new THREE.LineSegments(this.dropGeometry,new THREE.LineBasicMaterial({color:0x9dcbdc,transparent:true,opacity:.45,depthWrite:false}));this.weatherGroup.add(this.rain);this.rain.visible=false;
  }
  setNetwork(network,selected){
    this.network=network;clear(this.facilities);this.lampMaterials=[];this.lights=[];
    for(const f of network.facilities||[]){
      if(f.type==='trafficLight')continue;
      // 确保路灯朝向道路：以灯基座指向道路中心线的向量为准
      let heading=f.heading||0;
      if(f.type==='streetlight'){
        if(f.roadId&&network?.roads){
          const road=network.roads.find(r=>r.id===f.roadId);
          if(road){
            const center=roadPointAt(network,road,f.s||0);
            const toRoadX=center.x-f.x,toRoadZ=center.z-f.z;
            if(Math.hypot(toRoadX,toRoadZ)>0.01){
              heading=Math.atan2(-toRoadZ,toRoadX);
            }
          }
        }else if(f.side===-1){
          heading=(f.heading||0)+Math.PI;
        }
      }
      const group=new THREE.Group();group.position.set(f.x,.46,f.z);group.rotation.y=heading;group.userData.facilityId=f.id;
      if(f.type==='streetlight'){
        const layout=streetlightLayout(network,f);
        group.position.set(layout.position.x,.46,layout.position.z);
        group.rotation.y=layout.heading;
        const source=this.models.get('lamp');
        if(source){
          const model=source.clone(true);
          model.scale.y=layout.height/5.8;
          const armGroup=new THREE.Group(),parts=[];
          model.traverse(n=>{if(n.isMesh&&/curved_arm|lamp_emitter|lamp_shell/i.test(n.name))parts.push(n);});
          for(const part of parts)armGroup.add(part);
          armGroup.scale.x=(layout.reach-.35)/1.2;model.add(armGroup);
          model.traverse(n=>{if(n.isMesh){n.userData.asset=true;if(/emitter|lamp_off/i.test(n.name+' '+n.material?.name)){n.material=n.material.clone();n.material.emissive=new THREE.Color(0xffdc9c);this.lampMaterials.push(n.material);}}});
          group.add(model);
        }else{
          const m=material(0x74818a),post=box(.18,layout.height,.18,m);post.position.y=layout.height/2;group.add(post);
          const arm=box(layout.reach,.16,.16,m);arm.position.set(layout.reach/2,layout.height-.1,0);group.add(arm);
          const bulb=box(.8,.15,.4,material(0xf2dfb6,{emissive:0xffdd99,emissiveIntensity:1}));bulb.position.set(layout.reach-.35,layout.height-.2,0);group.add(bulb);
          this.lampMaterials.push(bulb.material);
        }
        if(this.lights.length<10){
          const light=new THREE.PointLight(0xffd899,0,Math.max(20,layout.reach*4),2);
          light.position.set(layout.reach-.35,source?layout.height*5.626/5.8:layout.height-.2,0);
          group.add(light);this.lights.push(light);
        }
      }else{
        const pole=box(.12,2.9,.12,material(0x9aa5a7));pole.position.y=1.45;group.add(pole);
        const sign=new THREE.Mesh(new THREE.CylinderGeometry(.78,.78,.09,f.type==='stopSign'?8:40),material(f.type==='stopSign'?0xb7473b:0xe4e9e5));sign.rotation.x=Math.PI/2;sign.position.y=2.7;group.add(sign);
        const canvas=document.createElement('canvas');canvas.width=128;canvas.height=128;const c=canvas.getContext('2d');c.clearRect(0,0,128,128);c.fillStyle=f.type==='stopSign'?'#fff':'#18313a';c.font='bold 64px Microsoft YaHei,sans-serif';c.textAlign='center';c.textBaseline='middle';const road=network.roads.find(r=>r.id===f.roadId);c.fillText(f.type==='stopSign'?'停':String(road?.speedLimit||50),64,65);const plane=new THREE.Mesh(new THREE.PlaneGeometry(1.38,1.38),new THREE.MeshBasicMaterial({map:new THREE.CanvasTexture(canvas),transparent:true,side:THREE.DoubleSide}));plane.position.set(0,2.7,.06);group.add(plane);
      }
      if(selected===f.id){const ring=new THREE.Mesh(new THREE.RingGeometry(.9,1.25,32),new THREE.MeshBasicMaterial({color:0xffbd4c,side:THREE.DoubleSide}));ring.rotation.x=-Math.PI/2;ring.position.y=.04;group.add(ring);}
      this.facilities.add(group);
    }
    this.environment(this.settings);
  }
  environment(settings){this.settings={...this.settings,...settings};const night=this.settings.timeOfDay==='night';for(const m of this.lampMaterials)m.emissiveIntensity=night?2.5:.05;for(const l of this.lights)l.intensity=night?16:0;this.rain.visible=['rain','snow'].includes(this.settings.weather);this.rain.material.color.setHex(this.settings.weather==='snow'?0xecf2f4:0x9dcbdc);}
  incidentModel(item){
    const group=new THREE.Group();group.position.set(item.x,.5,item.z);
    const warning=new THREE.Mesh(new THREE.ConeGeometry(.9,1.6,3),material(0xff9d49,{emissive:0xd54e20,emissiveIntensity:.4}));warning.position.set(0,2,0);group.add(warning);group.userData.warning=warning;
    const ring=new THREE.Mesh(new THREE.TorusGeometry(3.5,.1,6,48),new THREE.MeshBasicMaterial({color:0xff6e54,transparent:true,opacity:.8}));ring.rotation.x=Math.PI/2;ring.position.y=.08;group.add(ring);
    return group;
  }
  update(snapshot,center={x:0,z:0}){
    const live=new Set((snapshot.incidents||[]).map(i=>i.id));for(const[id,g]of this.incidents)if(!live.has(id)){this.incidentGroup.remove(g);this.incidents.delete(id);clear(g);}
    for(const item of snapshot.incidents||[]){let g=this.incidents.get(item.id);if(!g){g=this.incidentModel(item);this.incidents.set(item.id,g);this.incidentGroup.add(g);}g.position.set(item.x,.5,item.z);const age=item.age||0;g.userData.warning.rotation.y=age*.7;}
    if(this.rain.visible){const snow=this.settings.weather==='snow',speed=snow?2:15;for(let i=0;i<180;i++){const x=((i*43.27)%160)-80+center.x,z=((i*29.19)%160)-80+center.z,y=2+((i*7.3-snapshot.time*speed)%40+40)%40;const k=i*6;this.dropPositions[k]=x;this.dropPositions[k+1]=y;this.dropPositions[k+2]=z;this.dropPositions[k+3]=x+(snow?.2:.45);this.dropPositions[k+4]=y+(snow?.2:2);this.dropPositions[k+5]=z+.1;}this.dropGeometry.attributes.position.needsUpdate=true;}
  }
  visible(mode){this.facilities.visible=mode!=='garage';this.incidentGroup.visible=mode==='run';this.weatherGroup.visible=mode!=='garage';}
  reset(){clear(this.incidentGroup);this.incidents.clear();}
}
