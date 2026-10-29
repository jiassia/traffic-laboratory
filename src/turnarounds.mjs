import {roadPath,roadPointAt} from './geometry.mjs';
import {roadWidth} from './lanes.mjs';
import {terminalIds} from './terminals.mjs';
import {vehicleFootprint} from './junction-design.mjs';

const dot=(a,b)=>a.x*b.x+a.z*b.z;
const delta=(a,b)=>({x:a.x-b.x,z:a.z-b.z});
const cross=(a,b)=>a.x*b.z-a.z*b.x;
const move=(p,v,d)=>({x:p.x+v.x*d,z:p.z+v.z*d});
function contains(p,polygon){
  let inside=false;
  for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
    const a=polygon[j],b=polygon[i],v=delta(b,a),q=delta(p,a);
    if(Math.abs(cross(v,q))<1e-7&&dot(q,v)>=-1e-7&&dot(q,v)<=dot(v,v)+1e-7)return true;
    if((a.z>p.z)!==(b.z>p.z)&&p.x<(b.x-a.x)*(p.z-a.z)/(b.z-a.z)+a.x)inside=!inside;
  }
  return inside;
}
function outsidePieces([a,b],polygon){
  const d=delta(b,a),cuts=[0,1];
  for(let i=0;i<polygon.length;i++){
    const p=polygon[i],e=delta(polygon[(i+1)%polygon.length],p),den=cross(d,e);
    if(Math.abs(den)<1e-10)continue;
    const q=delta(p,a),t=cross(q,e)/den,u=cross(q,d)/den;
    if(t>0&&t<1&&u>=0&&u<=1)cuts.push(t);
  }
  cuts.sort((x,y)=>x-y);const at=t=>move(a,d,t),pieces=[];
  for(let i=1;i<cuts.length;i++)if((cuts[i]-cuts[i-1])*Math.hypot(d.x,d.z)>.03&&!contains(at((cuts[i]+cuts[i-1])/2),polygon))pieces.push([at(cuts[i-1]),at(cuts[i])]);
  return pieces;
}
function bezier(a,b,c,d,t){const u=1-t;return{x:u*u*u*a.x+3*u*u*t*b.x+3*u*t*t*c.x+t*t*t*d.x,z:u*u*u*a.z+3*u*u*t*b.z+3*u*t*t*c.z+t*t*t*d.z};}
// An analytic circular front cap with two tangent-continuous cubic shoulders.
// The front cap is symmetric in the actual endpoint tangent frame. Only the
// neck bends to meet a curved road's mouth. These are visual fit parameters.
function contour(node,axis,mouth,mouthAxis,half,radius,trim){
  const normal={x:-axis.z,z:axis.x},mouthNormal={x:-mouthAxis.z,z:mouthAxis.x},points=[],handle=Math.max(1,Math.min(trim*.45,Math.hypot(node.x-mouth.x,node.z-mouth.z)*.6));
  const lower=move(mouth,mouthNormal,-half),upper=move(mouth,mouthNormal,half),capLow=move(node,normal,-radius),capHigh=move(node,normal,radius);
  for(let i=0;i<48;i++)points.push(bezier(lower,move(lower,mouthAxis,handle),move(capLow,axis,-handle),capLow,i/48));
  for(let i=0;i<=128;i++){const angle=-Math.PI/2+Math.PI*i/128;points.push(move(move(node,axis,radius*Math.cos(angle)),normal,radius*Math.sin(angle)));}
  for(let i=1;i<=48;i++)points.push(bezier(capHigh,move(capHigh,axis,-handle),move(upper,mouthAxis,handle),upper,i/48));
  return points;
}
export function roadTurnarounds(network,road,connections,{vehicleLength,vehicleWidth,margin=.65,curbMargin=1.35}={}){
  if(road.oneWay)return [];
  const ports=new Set([...terminalIds(network,'source'),...terminalIds(network,'sink')]),path=roadPath(network,road),result=[],half=roadWidth(road)/2;
  for(const end of ['a','b']){
    const nodeId=road[end];if(ports.has(nodeId)||network.roads.filter(r=>r.a===nodeId||r.b===nodeId).length!==1)continue;
    const turns=connections.filter(c=>c.uTurn&&c.nodeId===nodeId&&c.inRoadId===road.id&&c.outRoadId===road.id);if(!turns.length)continue;
    const sign=end==='a'?-1:1,node=roadPointAt(network,road,end==='a'?0:path.length),axis={x:node.tangentX*sign,z:node.tangentZ*sign},normal={x:-axis.z,z:axis.x},body=[],curbBody=[];
    // Include intermediate yaw interpolation, just as the engine does.
    for(const turn of turns)for(let i=1;i<turn.points.length;i++)for(let j=0;j<=4;j++){
      const a=turn.points[i-1],b=turn.points[i],t=j/4,angle=Math.atan2(Math.sin(b.yaw-a.yaw),Math.cos(b.yaw-a.yaw));
      const pose={x:a.x+(b.x-a.x)*t,z:a.z+(b.z-a.z)*t,yaw:a.yaw+angle*t};
      body.push(...vehicleFootprint(pose,vehicleLength,vehicleWidth,margin));curbBody.push(...vehicleFootprint(pose,vehicleLength,vehicleWidth,margin+curbMargin));
    }
    let radius=Math.max(half,...body.map(p=>{const v=delta(p,node);return dot(v,axis)>=0?Math.hypot(v.x,v.z):Math.abs(dot(v,normal));}))+ .15;
    let trim=Math.min(path.length,Math.max(3,-Math.min(...body.map(p=>dot(delta(p,node),axis)))+2));
    let mouth,mouthAxis,polygon;
    for(let attempt=0;attempt<40;attempt++){
      mouth=roadPointAt(network,road,end==='a'?trim:path.length-trim);mouthAxis={x:mouth.tangentX*sign,z:mouth.tangentZ*sign};
      const behind=-Math.min(...curbBody.map(p=>dot(delta(p,mouth),mouthAxis)));
      if(behind>-.8&&trim<path.length){trim=Math.min(path.length,trim+Math.max(.5,behind+1));continue;}
      polygon=contour(node,axis,mouth,mouthAxis,half,radius,trim);
      const contourForCurb=contour(node,axis,mouth,mouthAxis,half+curbMargin,radius+curbMargin,trim);
      // Preserve the complete existing curved road, not just turning vehicles.
      // A small interior cushion avoids submillimetre slivers between sampled
      // offset paths and the analytic neck, while the mouth stays exact.
      const roadSamples=[],curbSamples=[],steps=Math.max(2,Math.ceil(trim/.1));
      for(let i=0;i<=steps;i++){
        const t=i/steps,s=end==='a'?trim*t:path.length-trim*t,cushion=.01*Math.sin(Math.PI*t)**2;
        for(const side of [-1,1]){
          roadSamples.push(roadPointAt(network,road,s,(half+cushion)*side));
          curbSamples.push(roadPointAt(network,road,s,(half+curbMargin+cushion)*side));
        }
      }
      if(body.every(p=>contains(p,polygon))&&curbBody.every(p=>contains(p,contourForCurb))&&roadSamples.every(p=>contains(p,polygon))&&curbSamples.every(p=>contains(p,contourForCurb)))break;
      radius*=1.12;trim=Math.min(path.length,trim+.5);
    }
    // Recompute at the accepted mouth after the final adaptive step.
    mouth=roadPointAt(network,road,end==='a'?trim:path.length-trim);mouthAxis={x:mouth.tangentX*sign,z:mouth.tangentZ*sign};
    polygon=contour(node,axis,mouth,mouthAxis,half,radius,trim);
    const curbPolygon=contour(node,axis,mouth,mouthAxis,half+curbMargin,radius+curbMargin,trim),inner=contour(node,axis,mouth,mouthAxis,Math.max(.1,half-.45),Math.max(.1,radius-.45),trim),outline=[];
    for(let i=1;i<inner.length;i++)outline.push([inner[i-1],inner[i]]);
    const preferred=turns.find(c=>c.preferred)||turns.reduce((a,b)=>a.length<b.length?a:b);
    result.push({nodeId,roadId:road.id,end,trim,polygon,curbPolygon,outline,guide:preferred.points});
  }
  for(const pad of result)for(const other of result)if(pad!==other)pad.outline=pad.outline.flatMap(edge=>outsidePieces(edge,other.polygon));
  return result;
}
