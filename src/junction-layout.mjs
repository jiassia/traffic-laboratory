import {roadPath,roadPointAt} from './geometry.mjs';
import {roadWidth} from './lanes.mjs';

const EPS=1e-6,BASE_TRIM=2,CLEARANCE=1.2;
const cache=new WeakMap();
const dot=(a,b)=>a.x*b.x+a.z*b.z;
const sub=(a,b)=>({x:a.x-b.x,z:a.z-b.z});
const cross=(a,b,c)=>(b.x-a.x)*(c.z-a.z)-(b.z-a.z)*(c.x-a.x);
const finitePoint=p=>Number.isFinite(p.x)&&Number.isFinite(p.z);

export function convexJunctionPolygon(points){
  const sorted=points.filter(finitePoint).map(p=>({x:p.x,z:p.z})).sort((a,b)=>a.x-b.x||a.z-b.z).filter((p,i,a)=>!i||Math.hypot(p.x-a[i-1].x,p.z-a[i-1].z)>EPS);
  if(sorted.length<3)return sorted;
  const lower=[],upper=[];
  for(const p of sorted){while(lower.length>=2&&cross(lower.at(-2),lower.at(-1),p)<=EPS)lower.pop();lower.push(p);}
  for(const p of [...sorted].reverse()){while(upper.length>=2&&cross(upper.at(-2),upper.at(-1),p)<=EPS)upper.pop();upper.push(p);}
  return [...lower.slice(0,-1),...upper.slice(0,-1)];
}

function mouth(network,arm,trim){
  const s=arm.end==='a'?trim:arm.length-trim,p=roadPointAt(network,arm.road,s),sign=arm.end==='a'?1:-1;
  const outward={x:p.tangentX*sign,z:p.tangentZ*sign},normal={x:-outward.z,z:outward.x},half=arm.width/2;
  return {...arm,trim,center:{x:p.x,z:p.z},outward,left:{x:p.x+normal.x*half,z:p.z+normal.z*half},right:{x:p.x-normal.x*half,z:p.z-normal.z*half}};
}
function supportViolation(arm,others){
  let maximum=0;
  for(const other of others)if(other!==arm)for(const p of [other.left,other.right])maximum=Math.max(maximum,dot(sub(p,arm.center),arm.outward)+CLEARANCE);
  return maximum;
}
function straight(path){const first=path.segments[0];return path.segments.every(s=>s.dx*first.dx+s.dz*first.dz>1-1e-8);}

// Networks produced by editing/parsing are immutable snapshots, like roadPath's cache.
// Each mouth is shared by road strips, intersection patches and lane connectors.
export function junctionLayout(network){
  const stored=cache.get(network);if(stored&&stored.roads===network.roads&&stored.nodes===network.nodes)return stored.layout;
  const byNode=new Map(network.nodes.map(node=>[node.id,{nodeId:node.id,node:{x:node.x,z:node.z},arms:[],polygon:[],feasible:true}]));
  const pathByRoad=new Map();
  for(const road of network.roads){
    const path=roadPath(network,road),width=roadWidth(road);pathByRoad.set(road.id,path);
    for(const end of ['a','b']){const nodeId=road[end],layout=byNode.get(nodeId);if(!layout)throw new Error('路口引用的道路节点不存在');layout.arms.push({roadId:road.id,road,end,length:path.length,width,requiredTrim:0,maxTrim:0,trim:0,straight:straight(path)});}
  }
  for(const layout of byNode.values()){
    if(layout.arms.length<2)continue;
    for(const arm of layout.arms)arm.requiredTrim=BASE_TRIM;
    // The closed form accelerates very acute straight forks. Curves use their actual
    // mouth positions below, so parallel starting tangents do not imply infinite trims.
    const initial=layout.arms.map(a=>mouth(network,a,0));
    if(initial.length>=3){
      const ordered=[...initial].sort((a,b)=>Math.atan2(a.outward.z,a.outward.x)-Math.atan2(b.outward.z,b.outward.x));
      for(let i=0;i<ordered.length;i++){
        const arm=ordered[i],previous=ordered[(i+ordered.length-1)%ordered.length],next=ordered[(i+1)%ordered.length];
        // Every corner receives room for a complete bus, irrespective of the
        // current lane-turn permissions. The road-wide budget below still owns
        // the final mouth positions at both ends of each road.
        const required=Math.max(previous.width,next.width)/2+10.923;
        layout.arms.find(a=>a.roadId===arm.roadId).requiredTrim=Math.max(BASE_TRIM,required);
      }
    }
    if(initial.length===2){
      const angle=Math.acos(Math.max(-1,Math.min(1,-dot(initial[0].outward,initial[1].outward))));
      if(angle>.08&&angle<Math.PI-.08){
        const radius=Math.max(...initial.map(a=>a.width/2))+7;
        const tangent=radius*Math.tan(angle/2);
        for(const arm of layout.arms)arm.requiredTrim=Math.max(arm.requiredTrim,tangent);
      }
    }
    // A layout rule for this teaching model, not a calibrated road-design standard:
    // opposite unequal carriageways get longitudinal space for a gradual lane fan.
    if(initial.length===2&&dot(initial[0].outward,initial[1].outward)<-.95){
      const taper=BASE_TRIM+Math.abs(initial[0].width-initial[1].width)/2;
      for(const arm of layout.arms)arm.requiredTrim=Math.max(arm.requiredTrim,taper);
    }
    for(let i=0;i<initial.length;i++)for(let j=i+1;j<initial.length;j++){
      const a=initial[i],b=initial[j],cos=Math.max(-1,Math.min(1,dot(a.outward,b.outward))),sin=Math.sqrt(Math.max(0,1-cos*cos));
      if(!a.straight||!b.straight||cos<=0)continue;
      const cap=10000;
      const neededA=sin>1e-5?(b.width/2+a.width/2*cos)/sin+CLEARANCE/Math.max(1e-8,1-cos):cap;
      const neededB=sin>1e-5?(a.width/2+b.width/2*cos)/sin+CLEARANCE/Math.max(1e-8,1-cos):cap;
      layout.arms[i].requiredTrim=Math.max(layout.arms[i].requiredTrim,Math.min(cap,neededA));
      layout.arms[j].requiredTrim=Math.max(layout.arms[j].requiredTrim,Math.min(cap,neededB));
    }
    for(let iteration=0;iteration<80;iteration++){
      const mouths=layout.arms.map(a=>mouth(network,a,a.requiredTrim));let change=0;
      for(let i=0;i<mouths.length;i++){
        const violation=supportViolation(mouths[i],mouths);if(violation<1e-4)continue;
        const arm=layout.arms[i],next=Math.min(10000,arm.requiredTrim+violation*.8);change=Math.max(change,next-arm.requiredTrim);arm.requiredTrim=next;
      }
      if(change<1e-4)break;
    }
  }
  // Leave a real road span between neighboring mouths. Allocate one shared budget,
  // rather than imposing a quarter-length cap that unnecessarily rejects a single bend.
  for(const road of network.roads){
    const a=byNode.get(road.a).arms.find(x=>x.roadId===road.id),b=byNode.get(road.b).arms.find(x=>x.roadId===road.id),length=pathByRoad.get(road.id).length;
    const budget=Math.max(0,length-Math.min(4,length*.2)),total=a.requiredTrim+b.requiredTrim,scale=total>budget?budget/total:1;
    a.trim=a.requiredTrim*scale;b.trim=b.requiredTrim*scale;a.maxTrim=b.maxTrim=budget;
  }
  const issues=[];
  for(const layout of byNode.values()){
    const arms=layout.arms.map(a=>mouth(network,a,a.trim));layout.arms=arms;
    if(arms.length>=2)layout.polygon=convexJunctionPolygon(arms.flatMap(a=>[a.left,a.right]));
    for(const arm of arms){
      const violation=arms.length>=2?supportViolation(arm,arms):0,missing=arm.requiredTrim-arm.trim;
      if(missing>.05||violation>.05){
        layout.feasible=false;
        const needed=Math.max(arm.requiredTrim,arm.trim+violation),message=`路口空间不足：需 ${needed.toFixed(1)} 米，现有 ${arm.trim.toFixed(1)} 米`;
        issues.push({nodeId:layout.nodeId,roadId:arm.roadId,requiredTrim:needed,availableTrim:arm.trim,message,detail:`路口 ${layout.nodeId}，道路 ${arm.roadId}。请拉开节点或减少车道。`});
      }
    }
  }
  const result={nodes:[...byNode.values()],byNode,issues};cache.set(network,{roads:network.roads,nodes:network.nodes,layout:result});return result;
}

export function roadEndTrim(network,road,nodeId){
  if(nodeId!==road.a&&nodeId!==road.b)throw new Error('路口不是此道路的端点');
  return junctionLayout(network).byNode.get(nodeId)?.arms.find(arm=>arm.roadId===road.id)?.trim??0;
}
export const junctionIssues=network=>junctionLayout(network).issues;
