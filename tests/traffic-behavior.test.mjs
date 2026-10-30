import test from 'node:test';
import assert from 'node:assert/strict';
import {createSimulation,defaultSettings} from '../src/simulation.mjs';
import {createPreset} from '../src/network.mjs';
import {collisionPairs,bodyOverlap} from '../src/incidents.mjs';

const road=(id,a,b,speedLimit=50,extra={})=>({id,a,b,type:'local',speedLimit,oneWay:true,lanesForward:1,lanesBackward:0,...extra});
const straight=(signals={})=>({version:1,nodes:[{id:'s',x:-300,z:0},{id:'j',x:0,z:0},{id:'t',x:300,z:0}],roads:[road('in','s','j'),road('out','j','t')],source:'s',sink:'t',signals,facilities:[]});
const settings=extra=>({...defaultSettings(),demand:1,...extra});

for(const enabled of [false,true])test(`clear straight junction preserves cruising speed with signal ${enabled?'green':'absent'}`,()=>{
  const signals=enabled?{j:{enabled:true,greenEW:20,greenNS:20,yellow:3,allRed:1,offset:0}}:{};
  const sim=createSimulation(straight(signals),settings({signalMode:'green'}));sim.updateSettings({demand:0});
  const speeds=[];let samples=0;
  for(let i=0;i<1200;i++){sim.step();const c=sim.snapshot({includeEvents:false}).vehicles[0];if(c&&Math.abs(c.x)<30){speeds.push(c.speed);if(c.junctionId)samples++;}}
  assert.ok(samples>0,'vehicle traversed the connector');
  assert.ok(Math.min(...speeds)>12.5,`junction speed ${Math.min(...speeds)*3.6} km/h`);
  assert.equal(sim.snapshot().stats.arrived,1);assert.equal(sim.snapshot().stats.collisions,0);
});

test('red signals still stop vehicles before the junction',()=>{
  const sim=createSimulation(straight({j:{enabled:true,greenEW:20,greenNS:20,yellow:3,allRed:1,offset:0}}),settings({signalMode:'red'}));sim.updateSettings({demand:0});sim.step(60);
  const c=sim.snapshot().vehicles[0];assert.ok(c.x<0);assert.ok(c.speed<.1);assert.equal(sim.snapshot().stats.collisions,0);
});

function alternatives(speedLimit=10){return {version:1,nodes:[{id:'s',x:-200,z:0},{id:'j',x:0,z:0},{id:'a',x:100,z:0},{id:'b',x:100,z:120},{id:'k',x:200,z:0},{id:'t',x:400,z:0}],roads:[road('entry','s','j'),road('short1','j','a',speedLimit),road('short2','a','k',speedLimit),road('fast1','j','b'),road('fast2','b','k'),road('exit','k','t')],source:'s',sink:'t',signals:{},facilities:[]};}

test('navigation chooses a longer fast road over the shortest slow route',()=>{
  const sim=createSimulation(alternatives(),settings());sim.updateSettings({demand:0});const used=new Set();
  for(let i=0;i<3000;i++){sim.step();for(const c of sim.snapshot({includeEvents:false}).vehicles)used.add(c.roadId);if(sim.snapshot({includeEvents:false}).stats.arrived)break;}
  assert.ok(used.has('fast1'));assert.ok(used.has('fast2'));assert.ok(!used.has('short1'));assert.equal(sim.snapshot().stats.arrived,1);assert.equal(sim.snapshot().stats.collisions,0);
});

test('navigation avoids a route whose next turn no lane permits',()=>{
  const n=alternatives(50);n.roads.find(r=>r.id==='entry').turnsForward=[['right']];
  // The branch at positive z is a right turn; the direct route is through.
  const sim=createSimulation(n,settings());sim.updateSettings({demand:0});const used=new Set();
  for(let i=0;i<3000;i++){sim.step();const snap=sim.snapshot({includeEvents:false});for(const c of snap.vehicles)used.add(c.roadId);if(snap.stats.arrived)break;}
  assert.ok(used.has('fast1'));assert.ok(!used.has('short1'));assert.equal(sim.snapshot().stats.turnLaneBlocked,0);assert.equal(sim.snapshot().stats.arrived,1);
});


test('new drivers divert around a blocked road with the same posted speed',()=>{
  const sim=createSimulation(alternatives(50),settings({incidentDuration:300}));sim.updateSettings({demand:0});
  let blocked;
  for(let i=0;i<1200;i++){sim.step();blocked=sim.snapshot({includeEvents:false}).vehicles.find(c=>c.roadId==='short1'&&c.x>20);if(blocked)break;}
  assert.ok(blocked,'first driver chose the free shortest road');
  sim.injectIncident({type:'breakdown',vehicleId:blocked.id});sim.updateSettings({demand:60});
  while(sim.snapshot({includeEvents:false}).stats.requested<2)sim.step();sim.updateSettings({demand:0});
  const used=new Set();
  for(let i=0;i<2200;i++){sim.step();const snap=sim.snapshot({includeEvents:false});for(const c of snap.vehicles)if(c.id===2)used.add(c.roadId);if(snap.stats.arrived)break;}
  assert.ok(used.has('fast1'));assert.ok(!used.has('short1'));assert.equal(sim.snapshot().stats.arrived,1);assert.equal(sim.snapshot().stats.collisions,0);
});

test('busy signalled traffic drains without body overlap or collisions',()=>{
  const sim=createSimulation(createPreset('signal'),settings({demand:90}));
  for(let i=0;i<7000;i++){
    if(i===200)sim.updateSettings({demand:0});sim.step();
    if(i%4)continue;const snap=sim.snapshot({includeEvents:false});
    for(const [a,b] of collisionPairs(snap.vehicles))assert.equal(bodyOverlap(snap.vehicles[a],snap.vehicles[b],.02),false,`body overlap at ${snap.time}`);
    if(i>200&&snap.stats.active+snap.stats.queued===0)break;
  }
  const snap=sim.snapshot();assert.equal(snap.stats.arrived,snap.stats.requested);assert.equal(snap.stats.collisions,0);assert.equal(snap.stats.active+snap.stats.queued,0);
});


test('an approaching driver revises a reserved route after a downstream incident',()=>{
  const sim=createSimulation(alternatives(50),settings({demand:60,incidentDuration:300}));
  while(sim.snapshot({includeEvents:false}).stats.requested<2)sim.step();sim.updateSettings({demand:0});let injected=false;
  for(let i=0;i<2500;i++){
    sim.step();const snap=sim.snapshot({includeEvents:false});
    if(!injected&&snap.vehicles.some(c=>c.id===1&&c.roadId==='short1'&&c.x>20)){
      assert.ok(snap.vehicles.some(c=>c.id===2&&c.roadId==='entry'),'second driver is still approaching the choice');
      sim.injectIncident({type:'breakdown',vehicleId:1});injected=true;
    }
    if(snap.stats.arrived)break;
  }
  const snap=sim.snapshot();assert.ok(injected);assert.ok(snap.events.some(e=>e.type==='route-replanned'&&e.vehicleId===2&&e.toRoadId==='fast1'));assert.equal(snap.stats.arrived,1);assert.equal(snap.stats.collisions,0);
});
