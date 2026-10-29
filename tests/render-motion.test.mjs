import test from 'node:test';
import assert from 'node:assert/strict';
import {VehicleMotion} from '../src/render-motion.mjs';

const car=(x,yaw=0)=>({id:1,x,z:0,yaw,speed:10,distance:x,steeringAngle:0,crashed:false});
const snap=(time,x,yaw)=>({time,vehicles:[car(x,yaw)]});
test('20 Hz simulation is presented continuously at 60 Hz without extrapolation',()=>{
  const motion=new VehicleMotion();motion.sample(snap(0,0),0);
  motion.sample(snap(.05,.5),0);
  const xs=[0,1/60,2/60,.05].map(time=>motion.sample(snap(.05,.5),time)[0].x);
  assert.ok(Math.abs(xs[1]-1/6)<1e-8);assert.ok(Math.abs(xs[2]-1/3)<1e-8);
  assert.deepEqual([xs[0],xs[3]],[0,.5]);
  assert.equal(motion.sample(snap(.05,.5),.2)[0].x,.5);
});
test('4x frames interpolate movement and cross the angle wrap along the short arc',()=>{
  const motion=new VehicleMotion();motion.sample(snap(0,0,Math.PI-.1),0);
  const rendered=motion.sample(snap(.1,1,-Math.PI+.1),.05)[0];
  assert.equal(rendered.x,.5);assert.ok(Math.abs(rendered.yaw-Math.PI)<1e-8);
  assert.equal(motion.sample(snap(.1,1,0),.05,false)[0].x,1);
});
test('new runs and collisions do not blend across unrelated states',()=>{
  const motion=new VehicleMotion();motion.sample(snap(10,100),10);
  assert.equal(motion.sample(snap(0,0),-.05)[0].x,0);
  const crashed={time:.05,vehicles:[{...car(.5),crashed:true}]};
  assert.equal(motion.sample(crashed,.025)[0].x,.5);
});
