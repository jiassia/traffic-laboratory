// Shared metre-based centreline geometry for editing, rendering and vehicle motion.
const EPS=1e-8;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const distance=(a,b)=>Math.hypot(b.x-a.x,b.z-a.z);
const cache=new WeakMap();
const point=p=>({x:Number(p.x),z:Number(p.z)});
function checkedPoint(p){if(!p||!Number.isFinite(p.x)||!Number.isFinite(p.z))throw new Error('道路坐标必须为有限数值');return point(p);}

export function pathLength(points){let length=0;for(let i=1;i<points.length;i++)length+=distance(points[i-1],points[i]);return length;}

export function makePath(input){
  const points=input.map(checkedPoint).filter((p,i,list)=>!i||distance(p,list[i-1])>EPS);
  if(points.length<2)throw new Error('道路需要两个不同的几何点');
  const distances=[0],segments=[];
  for(let i=1;i<points.length;i++){
    const a=points[i-1],b=points[i],length=distance(a,b);
    segments.push({a,b,length,dx:(b.x-a.x)/length,dz:(b.z-a.z)/length,s:distances[i-1],index:i-1});distances.push(distances[i-1]+length);
  }
  const closed=distance(points[0],points.at(-1))<EPS;
  const tangents=points.map((p,i)=>{
    const before=segments[closed&&i===0?segments.length-1:Math.max(0,i-1)],after=segments[closed&&i===points.length-1?0:Math.min(segments.length-1,i)];
    let dx=before.dx+after.dx,dz=before.dz+after.dz,l=Math.hypot(dx,dz);
    if(l<EPS){dx=after.dx;dz=after.dz;l=1;}
    return {dx:dx/l,dz:dz/l};
  });
  return {points,distances,segments,tangents,length:distances.at(-1)};
}

export function roadPath(network,road){
  const old=cache.get(road);if(old&&old.nodes===network.nodes&&old.source===road.points)return old.path;
  const a=network.nodes.find(n=>n.id===road.a),b=network.nodes.find(n=>n.id===road.b);
  if(!a||!b)throw new Error('道路端点不存在');
  const input=road.points?.length>=2?road.points:[a,b];
  const path=makePath(input);cache.set(road,{nodes:network.nodes,source:road.points,path});return path;
}

export function pathPointAt(path,s,offset=0){
  if(!Number.isFinite(s)||!Number.isFinite(offset))throw new Error('道路距离与偏移必须为有限数值');
  let index=0,t=0;
  if(s<0){const a=path.points[0],seg=path.segments[0];return{x:a.x+seg.dx*s-seg.dz*offset,z:a.z+seg.dz*s+seg.dx*offset,yaw:Math.atan2(seg.dx,seg.dz),curvature:0,tangentX:seg.dx,tangentZ:seg.dz};}
  if(s>path.length){const a=path.points.at(-1),seg=path.segments.at(-1),d=s-path.length;return{x:a.x+seg.dx*d-seg.dz*offset,z:a.z+seg.dz*d+seg.dx*offset,yaw:Math.atan2(seg.dx,seg.dz),curvature:0,tangentX:seg.dx,tangentZ:seg.dz};}
  let low=0,high=path.distances.length-1;while(low+1<high){const mid=(low+high)>>1;if(path.distances[mid]<=s)low=mid;else high=mid;}index=Math.min(low,path.segments.length-1);
  const seg=path.segments[index];t=clamp((s-seg.s)/seg.length,0,1);
  const first=path.tangents[index],last=path.tangents[index+1];let dx=first.dx+(last.dx-first.dx)*t,dz=first.dz+(last.dz-first.dz)*t;const norm=Math.hypot(dx,dz)||1;dx/=norm;dz/=norm;
  // Signed curvature follows d(yaw)/ds for yaw=atan2(dx,dz), not atan2(dz,dx).
  const angle=Math.atan2(first.dz*last.dx-first.dx*last.dz,first.dx*last.dx+first.dz*last.dz);
  return {x:seg.a.x+(seg.b.x-seg.a.x)*t-dz*offset,z:seg.a.z+(seg.b.z-seg.a.z)*t+dx*offset,yaw:Math.atan2(dx,dz),curvature:angle/seg.length,tangentX:dx,tangentZ:dz};
}
export function roadPointAt(network,road,s,offset=0){return pathPointAt(roadPath(network,road),s,offset);}
// Preserve every source vertex so pavement, paint and lane motion share the
// same bends, even when a short segment falls between regular metre samples.
export function samplePath(path,start=0,end=path.length,maxStep=3,offset=0){
  if(!Number.isFinite(maxStep)||maxStep<=0)throw new Error('道路采样间距必须大于零');
  const a=clamp(start,0,path.length),b=clamp(end,0,path.length);
  if(b<a)return [];
  const cuts=[a,...path.distances.filter(s=>s>a+EPS&&s<b-EPS),b],samples=[];
  for(let i=1;i<cuts.length;i++){
    const count=Math.max(1,Math.ceil((cuts[i]-cuts[i-1])/maxStep));
    for(let j=0;j<count;j++){const s=cuts[i-1]+(cuts[i]-cuts[i-1])*j/count;samples.push({...pathPointAt(path,s,offset),s});}
  }
  samples.push({...pathPointAt(path,b,offset),s:b});return samples;
}
export function projectOnPath(path,p){
  let result=null;
  for(const segment of path.segments){const d=(p.x-segment.a.x)*segment.dx+(p.z-segment.a.z)*segment.dz,t=clamp(d/segment.length,0,1);const x=segment.a.x+(segment.b.x-segment.a.x)*t,z=segment.a.z+(segment.b.z-segment.a.z)*t,dist=Math.hypot(p.x-x,p.z-z);
    if(!result||dist<result.distance-EPS)result={s:segment.s+segment.length*t,distance:dist,x,z,tangentX:segment.dx,tangentZ:segment.dz,segmentIndex:segment.index,t};
  }return result;
}
export function projectOnRoad(network,road,p){return projectOnPath(roadPath(network,road),p);}
export function roadSegments(network,road){return roadPath(network,road).segments;}

export function slicePath(path,start,end){
  const a=clamp(start,0,path.length),b=clamp(end,0,path.length);if(b-a<EPS)throw new Error('道路切分距离无效');
  const first=pathPointAt(path,a),last=pathPointAt(path,b);const points=[{x:first.x,z:first.z}];
  for(let i=1;i<path.points.length-1;i++)if(path.distances[i]>a+EPS&&path.distances[i]<b-EPS)points.push(point(path.points[i]));points.push({x:last.x,z:last.z});return points;
}

export function sampleCurve(start,control,end,segments=48){
  [start,control,end].forEach(checkedPoint);const count=clamp(Math.ceil(segments),8,256),points=[];
  for(let i=0;i<=count;i++){const t=i/count,u=1-t;points.push({x:u*u*start.x+2*u*t*control.x+t*t*end.x,z:u*u*start.z+2*u*t*control.z+t*t*end.z});}return points;
}
export function sampleCubic(start,c1,c2,end,segments=64){
  [start,c1,c2,end].forEach(checkedPoint);const count=clamp(Math.ceil(segments),8,256),points=[];
  for(let i=0;i<=count;i++){const t=i/count,u=1-t;points.push({x:u*u*u*start.x+3*u*u*t*c1.x+3*u*t*t*c2.x+t*t*t*end.x,z:u*u*u*start.z+3*u*u*t*c1.z+3*u*t*t*c2.z+t*t*t*end.z});}return points;
}
export function sampleCircle(center,radius,segments=64){
  checkedPoint(center);if(!Number.isFinite(radius)||radius<=0)throw new Error('圆形道路半径必须大于 0');const count=clamp(Math.ceil(segments),16,256),points=[];
  for(let i=0;i<=count;i++){const angle=2*Math.PI*i/count;points.push({x:center.x+radius*Math.cos(angle),z:center.z+radius*Math.sin(angle)});}points[points.length-1]={...points[0]};return points;
}
