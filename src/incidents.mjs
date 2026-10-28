// Planar body tests use the actual vehicle footprint. No rendering object participates.
const dot=(a,b)=>a.x*b.x+a.z*b.z;
export function bodyOverlap(a,b,margin=.01){
  if(Math.hypot(a.x-b.x,a.z-b.z)>(a.length+b.length+a.width+b.width)/2)return false;
  const af={x:Math.sin(a.yaw),z:Math.cos(a.yaw)},ar={x:Math.cos(a.yaw),z:-Math.sin(a.yaw)};
  const bf={x:Math.sin(b.yaw),z:Math.cos(b.yaw)},br={x:Math.cos(b.yaw),z:-Math.sin(b.yaw)},delta={x:a.x-b.x,z:a.z-b.z};
  return [af,ar,bf,br].every(axis=>Math.abs(dot(delta,axis))<(Math.abs(dot(af,axis))*a.length+Math.abs(dot(ar,axis))*a.width+Math.abs(dot(bf,axis))*b.length+Math.abs(dot(br,axis))*b.width)/2-margin);
}
export function sweptBodyOverlap(previousA,a,previousB,b){
  if(bodyOverlap(a,b))return true;
  const steps=Math.min(8,Math.max(2,Math.ceil(Math.max(Math.hypot(a.x-previousA.x,a.z-previousA.z),Math.hypot(b.x-previousB.x,b.z-previousB.z))/.65)));
  const lerp=(from,to,t)=>({...to,x:from.x+(to.x-from.x)*t,z:from.z+(to.z-from.z)*t,yaw:from.yaw+Math.atan2(Math.sin(to.yaw-from.yaw),Math.cos(to.yaw-from.yaw))*t});
  for(let i=1;i<steps;i++)if(bodyOverlap(lerp(previousA,a,i/steps),lerp(previousB,b,i/steps)))return true;
  return false;
}
export function collisionPairs(poses){
  const buckets=new Map(),pairs=[],seen=new Set(),size=20;
  for(let i=0;i<poses.length;i++){
    const p=poses[i],radius=Math.hypot(p.length,p.width)/2+2;
    const minX=Math.floor((p.x-radius)/size),maxX=Math.floor((p.x+radius)/size),minZ=Math.floor((p.z-radius)/size),maxZ=Math.floor((p.z+radius)/size);
    for(let x=minX;x<=maxX;x++)for(let z=minZ;z<=maxZ;z++){
      const key=`${x}:${z}`,items=buckets.get(key)||[];
      for(const j of items){const pair=`${Math.min(i,j)}:${Math.max(i,j)}`;if(!seen.has(pair)){seen.add(pair);pairs.push([j,i]);}}
      items.push(i);buckets.set(key,items);
    }
  }
  return pairs;
}
