import {roadPath,roadPointAt} from './geometry.mjs';
import {roadWidth} from './lanes.mjs';
import {terminalIds} from './terminals.mjs';
import {convexJunctionPolygon} from './junction-layout.mjs';
import {vehicleFootprint} from './junction-design.mjs';

const dot=(a,b)=>a.x*b.x+a.z*b.z;
const delta=(a,b)=>({x:a.x-b.x,z:a.z-b.z});
const cross=(a,b)=>a.x*b.z-a.z*b.x;

function outsidePieces(segment,polygon){
  const [a,b]=segment,d=delta(b,a);let lo=0,hi=1;
  for(let i=0;i<polygon.length;i++){
    const origin=polygon[i],edge=delta(polygon[(i+1)%polygon.length],origin),base=cross(edge,delta(a,origin)),slope=cross(edge,d);
    if(Math.abs(slope)<1e-9){if(base<=1e-6)return [segment];continue;}
    const t=(1e-6-base)/slope;if(slope>0)lo=Math.max(lo,t);else hi=Math.min(hi,t);
    if(lo>=hi)return [segment];
  }
  const at=t=>({x:a.x+d.x*t,z:a.z+d.z*t}),length=Math.hypot(d.x,d.z),pieces=[];
  if(lo*length>.03)pieces.push([a,at(lo)]);
  if((1-hi)*length>.03)pieces.push([at(hi),b]);
  return pieces;
}

function inset(polygon,distance){
  return polygon.map((p,i)=>{
    const before=polygon[(i+polygon.length-1)%polygon.length],after=polygon[(i+1)%polygon.length];
    const a=delta(p,before),b=delta(after,p),la=Math.hypot(a.x,a.z),lb=Math.hypot(b.x,b.z);
    const na={x:-a.z/la,z:a.x/la},nb={x:-b.z/lb,z:b.x/lb},sum={x:na.x+nb.x,z:na.z+nb.z};
    const scale=Math.min(distance/Math.max(.01,1+dot(na,nb)),distance*4/Math.max(.01,Math.hypot(sum.x,sum.z)));
    return {x:p.x+sum.x*scale,z:p.z+sum.z*scale};
  });
}

// Only a single ordinary bidirectional road end is widened here. The geometry
// comes from the same complete set of legal lane connections used by traffic.
export function roadTurnarounds(network,road,connections,{vehicleLength,vehicleWidth,margin=.65,curbMargin=1.35}={}){
  if(road.oneWay)return [];
  const ports=new Set([...terminalIds(network,'source'),...terminalIds(network,'sink')]),path=roadPath(network,road),result=[];
  for(const end of ['a','b']){
    const nodeId=road[end];if(ports.has(nodeId)||network.roads.filter(r=>r.a===nodeId||r.b===nodeId).length!==1)continue;
    const turns=connections.filter(c=>c.uTurn&&c.nodeId===nodeId&&c.inRoadId===road.id&&c.outRoadId===road.id);
    if(!turns.length)continue;
    const sign=end==='a'?-1:1,node=roadPointAt(network,road,end==='a'?0:path.length),body=[],curb=[];
    for(const turn of turns)for(const pose of turn.points){body.push(...vehicleFootprint(pose,vehicleLength,vehicleWidth,margin));curb.push(...vehicleFootprint(pose,vehicleLength,vehicleWidth,margin+curbMargin));}
    const outward={x:node.tangentX*sign,z:node.tangentZ*sign};
    let trim=Math.min(path.length,Math.max(2,-Math.min(...body.map(p=>dot(delta(p,node),outward)))));
    let mouth,axis;
    // Move the mouth back along the actual curve until its plane supports the
    // whole turning envelope. This also avoids a diagonal seam at curved ends.
    for(let i=0;i<24;i++){
      mouth=roadPointAt(network,road,end==='a'?trim:path.length-trim);axis={x:mouth.tangentX*sign,z:mouth.tangentZ*sign};
      const missing=-Math.min(...body.map(p=>dot(delta(p,mouth),axis)));
      if(missing<1e-5||trim>=path.length-1e-5)break;
      trim=Math.min(path.length,trim+Math.max(.25,missing));
    }
    const half=roadWidth(road)/2,normal={x:-axis.z,z:axis.x},mouthCorners=[-1,1].map(side=>({x:mouth.x+normal.x*half*side,z:mouth.z+normal.z*half*side}));
    // Include the curved road itself so the turning pad joins its full width.
    const steps=Math.max(2,Math.ceil(trim));
    for(let i=0;i<=steps;i++){
      const s=end==='a'?trim*(1-i/steps):path.length-trim+trim*i/steps;
      body.push(roadPointAt(network,road,s,-half),roadPointAt(network,road,s,half));
      curb.push(roadPointAt(network,road,s,-half-curbMargin),roadPointAt(network,road,s,half+curbMargin));
    }
    const polygon=convexJunctionPolygon(body),curbPolygon=convexJunctionPolygon(curb),inner=inset(polygon,.45),outline=[];
    for(let i=0;i<polygon.length;i++){
      const j=(i+1)%polygon.length;
      const mouthEdge=Math.abs(dot(delta(polygon[i],mouth),axis))<.03&&Math.abs(dot(delta(polygon[j],mouth),axis))<.03;
      if(!mouthEdge)outline.push([inner[i],inner[j]]);
    }
    // Close the two side-line joints, leaving the mouth open across the lanes.
    for(const corner of mouthCorners){
      let index=0;for(let i=1;i<polygon.length;i++)if(Math.hypot(polygon[i].x-corner.x,polygon[i].z-corner.z)<Math.hypot(polygon[index].x-corner.x,polygon[index].z-corner.z))index=i;
      if(Math.hypot(polygon[index].x-corner.x,polygon[index].z-corner.z)<.05){
        const side=dot(delta(corner,mouth),normal)>0?1:-1;
        outline.push([{x:mouth.x+normal.x*(half-.45)*side,z:mouth.z+normal.z*(half-.45)*side},inner[index]]);
      }
    }
    const preferred=turns.find(c=>c.preferred)||turns.reduce((a,b)=>a.length<b.length?a:b);
    result.push({nodeId,roadId:road.id,end,trim,polygon,curbPolygon,outline,guide:preferred.points});
  }
  // Splitting a road can leave a short section whose two pads overlap. Draw
  // their external boundary only, rather than a seam through the other pad.
  for(const pad of result)for(const other of result)if(pad!==other)pad.outline=pad.outline.flatMap(edge=>outsidePieces(edge,other.polygon));
  return result;
}
