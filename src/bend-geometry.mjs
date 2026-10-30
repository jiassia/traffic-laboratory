import {junctionLayout} from './junction-layout.mjs';
import {makePath,sampleCubic} from './geometry.mjs';

const cache=new WeakMap();
// The engine and renderer share these centreline samples and lateral normals.
export function bendGeometry(network,nodeId){
  let map=cache.get(network);if(!map){map=new Map();cache.set(network,map);}
  if(map.has(nodeId))return map.get(nodeId);
  const junction=junctionLayout(network).byNode.get(nodeId);
  if(junction?.arms.length!==2){map.set(nodeId,null);return null;}
  const [a,b]=[...junction.arms].sort((x,y)=>x.roadId.localeCompare(y.roadId));
  const dot=a.outward.x*b.outward.x+a.outward.z*b.outward.z;
  const angle=Math.acos(Math.max(-1,Math.min(1,-dot)));
  const span=Math.hypot(b.center.x-a.center.x,b.center.z-a.center.z);
  const factor=angle<.01?2/3:4/3*Math.tan(angle/4)/Math.max(.001,Math.tan(angle/2));
  const k=Math.min(span*.8,(a.trim+b.trim)/2*factor);
  const steps=Math.max(64,Math.min(256,Math.ceil((span+a.width+b.width)/.7)));
  const centers=sampleCubic(a.center,{x:a.center.x-a.outward.x*k,z:a.center.z-a.outward.z*k},{x:b.center.x-b.outward.x*k,z:b.center.z-b.outward.z*k},b.center,steps);
  const path=makePath(centers);
  const frames=centers.map((p,i)=>{const t=i/steps,blend=t*t*(3-2*t),v=i===0?{dx:-a.outward.x,dz:-a.outward.z}:i===steps?{dx:b.outward.x,dz:b.outward.z}:path.tangents[i];return{...p,blend,nx:v.dz,nz:-v.dx,half:(a.width+(b.width-a.width)*blend)/2};});
  const result={a,b,frames};map.set(nodeId,result);return result;
}

export function bendLanePath(network,inLane,outLane){
  if(inLane.road.id===outLane.road.id)return null;
  const bend=bendGeometry(network,inLane.to);if(!bend)return null;
  const forward=inLane.road.id===bend.a.roadId;
  const laneA=forward?inLane:outLane,laneB=forward?outLane:inLane;
  const oa=laneA.signedOffset*(bend.a.end==='a'?1:-1),ob=laneB.signedOffset*(bend.b.end==='a'?-1:1);
  let points=bend.frames.map(p=>{const offset=oa+(ob-oa)*p.blend;return{x:p.x+p.nx*offset,z:p.z+p.nz*offset};});
  if(!forward)points=points.reverse();
  return makePath(points);
}
