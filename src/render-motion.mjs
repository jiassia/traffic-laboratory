const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));

// Keep simulation positions authoritative. Only interpolate the presentation
// between completed snapshots; never extrapolate through a stop line.
export class VehicleMotion {
  constructor(){this.clear();}
  clear(){this.frames=[];}
  sample(snapshot,time=snapshot.time,smooth=true){
    const frames=this.frames,last=frames.at(-1);
    if(last&&snapshot.time<last.time)this.clear();
    if(!this.frames.length||snapshot.time>this.frames.at(-1).time){
      this.frames.push({time:snapshot.time,cars:new Map(snapshot.vehicles.map(car=>[car.id,car]))});
      if(this.frames.length>3)this.frames.shift();
    }
    if(!smooth||this.frames.length<2)return snapshot.vehicles;
    const current=this.frames.at(-1),before=[...this.frames].reverse().find(frame=>frame.time<=time)||this.frames[0];
    const after=this.frames.find(frame=>frame.time>=time)||current;
    const alpha=clamp((time-before.time)/Math.max(1e-8,after.time-before.time),0,1);
    return snapshot.vehicles.map(car=>{
      const a=before.cars.get(car.id),b=after.cars.get(car.id);
      if(!a||!b||a.crashed!==b.crashed||Math.hypot(b.x-a.x,b.z-a.z)>Math.max(20,(b.speed||0)*(after.time-before.time)*3))return car;
      const mix=key=>a[key]+(b[key]-a[key])*alpha;
      const yaw=a.yaw+Math.atan2(Math.sin(b.yaw-a.yaw),Math.cos(b.yaw-a.yaw))*alpha;
      return {...car,x:mix('x'),z:mix('z'),yaw,distance:mix('distance'),steeringAngle:(a.steeringAngle||0)+((b.steeringAngle||0)-(a.steeringAngle||0))*alpha};
    });
  }
}
