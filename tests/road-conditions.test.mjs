import test from 'node:test';
import assert from 'node:assert/strict';
import {createSimulation,defaultSettings} from '../src/simulation.mjs';

const network=(length=120,lanes=1)=>({version:1,
  nodes:[{id:'s',x:-length,z:0},{id:'j',x:0,z:0},{id:'t',x:150,z:0}],
  roads:[{id:'in',a:'s',b:'j',type:'local',speedLimit:50,oneWay:true,lanesForward:lanes,lanesBackward:0},
    {id:'out',a:'j',b:'t',type:'local',speedLimit:50,oneWay:true,lanesForward:lanes,lanesBackward:0}],
  source:'s',sink:'t',signals:{j:{enabled:true,greenEW:20,greenNS:20,yellow:3,allRed:1,offset:0}},facilities:[]});
const simulation=(length=120,lanes=1,settings={})=>createSimulation(network(length,lanes),{...defaultSettings(),demand:120,signalMode:'red',accidentsEnabled:false,...settings});
const twoCars=(length,lanes=1)=>{const sim=simulation(length,lanes);while(sim.snapshot().stats.requested<2)sim.step();sim.updateSettings({demand:0});return sim;};

test('two stopped cars on an ordinary road do not create a congestion warning',()=>{
  const sim=twoCars(120);sim.step(60);const r=sim.snapshot().roadStats.in;
  assert.equal(r.vehicleCount,2);assert.equal(r.queuedVehicles,2);
  assert.equal(r.level,'free');assert.ok(r.congestionScore<.05);
  assert.ok(r.storageOccupancy<.15);assert.equal(sim.snapshot().stats.congestedRoads,0);
});

test('a short nearly full bottleneck needs sustained evidence even with only two vehicles',()=>{
  const sim=twoCars(25);sim.step(15);const early=sim.snapshot().roadStats.in;
  assert.equal(early.level,'free');assert.ok(early.congestionScore<.25);
  sim.step(45);const blocked=sim.snapshot().roadStats.in;
  assert.equal(blocked.vehicleCount,2);assert.equal(blocked.level,'congested');
  assert.ok(blocked.maxLaneQueueOccupancy>.5);assert.ok(blocked.longestStoppedSeconds>=20);
  assert.ok(blocked.congestionEvidenceSeconds>=8);assert.ok(blocked.congestionScore>.8);
});

test('lane storage distinguishes two cars on a narrow road from two cars spread across four lanes',()=>{
  const narrow=twoCars(25),wide=twoCars(25,4);narrow.step(60);wide.step(60);
  const a=narrow.snapshot().roadStats.in,b=wide.snapshot().roadStats.in;
  assert.equal(a.vehicleCount,b.vehicleCount);assert.equal(b.usableLaneMetres,a.usableLaneMetres*4);
  assert.equal(b.storageOccupancy,a.storageOccupancy/4);
  assert.equal(b.level,'free');assert.ok(b.congestionScore<.05);
});

test('ordinary red-light waiting receives a grace period and startup does not trigger warnings',()=>{
  const sim=simulation(120,1,{demand:12,signalMode:'normal'});let sawRedWait=false;
  for(let i=0;i<1200;i++){
    sim.step();const r=sim.snapshot().roadStats.in;
    if(r.normalSignalWait){sawRedWait=true;assert.notEqual(r.level,'congested');assert.ok(r.congestionScore<.35);}
    if(sim.snapshot().time<6)assert.equal(r.level,'free');
  }
  assert.ok(sawRedWait);
});

test('a sustained queue develops continuous heat before a warning and recovers after release',()=>{
  const sim=simulation(90),values=[];let maxStep=0,previous=0;
  for(let i=0;i<1800;i++){
    sim.step();const r=sim.snapshot().roadStats.in;values.push(r.congestionScore);
    maxStep=Math.max(maxStep,Math.abs(r.congestionScore-previous));previous=r.congestionScore;
  }
  const blocked=sim.snapshot().roadStats.in;
  assert.equal(blocked.level,'congested');assert.ok(blocked.congestionScore>.8);
  assert.ok(new Set(values.filter(v=>v>.1&&v<.8).map(v=>v.toFixed(4))).size>100);
  assert.ok(maxStep<.02,`maximum single-step heat change ${maxStep}`);
  sim.updateSettings({demand:0,signalMode:'green'});
  for(let i=0;i<25&&(sim.snapshot().stats.queued||sim.snapshot().stats.active);i++)sim.step(60);
  sim.step(30);
  const clear=sim.snapshot().roadStats.in;
  assert.equal(clear.level,'empty');assert.ok(clear.congestionScore<.01);
  assert.equal(sim.snapshot().stats.congestedRoads,0);
});

test('road monitoring depends on simulation steps rather than snapshot call frequency',()=>{
  const a=simulation(90),b=simulation(90);
  a.step(60);
  for(let i=0;i<1200;i++){b.step();b.snapshot();b.snapshot({includeEvents:false});}
  assert.deepEqual(a.snapshot().roadStats,b.snapshot().roadStats);
});
