import test from 'node:test';
import assert from 'node:assert/strict';
import {createSimulation,defaultSettings,junctionConnections} from '../src/simulation.mjs';
import {createPreset} from '../src/network.mjs';
import {cornerBends,pavementFootprints} from '../src/junction-design.mjs';
import {roadTurnarounds} from '../src/turnarounds.mjs';
import {roadPath,roadPointAt} from '../src/geometry.mjs';
import {roadWidth,effectiveLaneTurns,laneAllowsMovement} from '../src/lanes.mjs';
import {bodyOverlap,collisionPairs} from '../src/incidents.mjs';

const envelope={vehicleLength:10.923,vehicleWidth:3.0224,margin:.65};
const road=attributes=>({type:'local',speedLimit:50,...attributes});

function contains(p,polygon){
  let inside=false;
  for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
    const a=polygon[j],b=polygon[i],dx=b.x-a.x,dz=b.z-a.z,qx=p.x-a.x,qz=p.z-a.z;
    if(dx*dx+dz*dz<1e-16)continue;
    const along=qx*dx+qz*dz;
    if(Math.abs(dx*qz-dz*qx)<1e-6&&along>=-1e-6&&along<=dx*dx+dz*dz+1e-6)return true;
    if((a.z>p.z)!==(b.z>p.z)&&p.x<(b.x-a.x)*(p.z-a.z)/(b.z-a.z)+a.x)inside=!inside;
  }
  return inside;
}

function mixedBend(angle,lanes,incomingOneWay,rotation){
  const turn=angle*Math.PI/180;
  const rotate=({x,z})=>({x:x*Math.cos(rotation)-z*Math.sin(rotation),z:x*Math.sin(rotation)+z*Math.cos(rotation)});
  return {version:1,
    nodes:[{id:'a',...rotate({x:-120,z:0})},{id:'j',x:0,z:0},{id:'b',...rotate({x:120*Math.cos(turn),z:120*Math.sin(turn)})}],
    roads:[road({id:'ra',a:'a',b:'j',oneWay:incomingOneWay,lanesForward:lanes,lanesBackward:incomingOneWay?0:lanes}),
      road({id:'rb',a:'j',b:'b',oneWay:!incomingOneWay,lanesForward:lanes,lanesBackward:incomingOneWay?lanes:0})],
    signals:{},facilities:[]};
}

test('mixed-direction bends generate no return connector or separate turnaround pavement',()=>{
  for(const angle of [30,60,90])for(const lanes of [1,2,3])for(const incomingOneWay of [false,true])for(const rotation of [0,Math.PI]){
    const network=mixedBend(angle,lanes,incomingOneWay,rotation);
    const connections=junctionConnections(network).filter(connection=>connection.nodeId==='j');
    const label=`${angle} degrees, ${lanes} lanes, incoming one-way ${incomingOneWay}, rotation ${rotation}`;
    assert.ok(connections.length>0,label);
    assert.ok(connections.every(connection=>!connection.uTurn),label);
    for(const r of network.roads){
      assert.equal(laneAllowsMovement(network,r,r.b==='j',0,r,r.b!=='j'),false,label);
      assert.ok(roadTurnarounds(network,r,connections,envelope).every(pad=>pad.nodeId!=='j'),label);
    }
    const twoWay=network.roads.find(r=>!r.oneWay);
    if(incomingOneWay)assert.deepEqual(effectiveLaneTurns(network,twoWay,twoWay.b==='j',0),[],label);

    // The base pavement must stay inside the visible bend and its two road
    // strips. This detects an unmarked U-turn sweep left underneath the bend.
    for(const curbMargin of [0,1.35]){
      const bend=cornerBends(network,curbMargin,connections,envelope).get('j');
      assert.ok(bend.smoothGeometry,label);
      const allowed=[bend.polygon,...network.roads.map(r=>{
        const path=roadPath(network,r),trim=bend.roadA.id===r.id?bend.renderTrimA:bend.renderTrimB;
        const start=r.a==='j'?trim:0,end=path.length-(r.b==='j'?trim:0),half=roadWidth(r)/2+curbMargin;
        return [roadPointAt(network,r,start,-half),roadPointAt(network,r,start,half),roadPointAt(network,r,end,half),roadPointAt(network,r,end,-half)];
      })];
      const pavement=pavementFootprints(network,connections,{...envelope,curbMargin});
      for(const polygon of pavement)for(const p of polygon)assert.ok(allowed.some(area=>contains(p,area)),`${label}: extra pavement at ${p.x}, ${p.z}`);
    }
  }
});

test('physical dead ends retain their legal return paths and turnaround pads',()=>{
  const network={version:1,nodes:[{id:'a',x:0,z:0},{id:'b',x:120,z:0}],
    roads:[road({id:'r',a:'a',b:'b',oneWay:false,lanesForward:1,lanesBackward:1})],signals:{},facilities:[]};
  const connections=junctionConnections(network),pads=roadTurnarounds(network,network.roads[0],connections,envelope);
  assert.equal(connections.filter(connection=>connection.uTurn).length,2);
  assert.equal(pads.length,2);
  assert.deepEqual(new Set(pads.map(pad=>pad.nodeId)),new Set(['a','b']));
  assert.deepEqual(effectiveLaneTurns(network,network.roads[0],true,0),['left']);
});

function branchNetwork(trap){
  return {version:1,
    nodes:[{id:'S',x:-180,z:0},{id:'J',x:0,z:0},{id:'T',x:180,z:0},{id:'D',x:0,z:-140},...(trap?[{id:'X',x:140,z:-140}]:[])],
    roads:[road({id:'entry',a:'S',b:'J',oneWay:true}),road({id:'exit',a:'J',b:'T',oneWay:true}),
      road({id:'branch',a:'J',b:'D',oneWay:false}),...(trap?[road({id:'inbound',a:'X',b:'D',oneWay:true})]:[])],
    source:'S',sink:'T',signals:{},facilities:[]};
}

function exploreAndDrain(network,label){
  const simulation=createSimulation(network,{...defaultSettings(),knownExit:false,demand:60,breakdown:0,violation:0,accidentsEnabled:false});
  let snapshot;
  for(let i=0;i<18000;i++){
    if(i===600)simulation.updateSettings({demand:0});
    simulation.step();
    if(i%2!==0)continue;
    snapshot=simulation.snapshot({includeEvents:false});
    for(const car of snapshot.vehicles)assert.ok([car.x,car.z,car.yaw,car.speed].every(Number.isFinite),`${label}: non-finite vehicle ${car.id}`);
    for(const [a,b] of collisionPairs(snapshot.vehicles))assert.equal(bodyOverlap(snapshot.vehicles[a],snapshot.vehicles[b],.02),false,`${label}: body overlap at ${snapshot.time}`);
    if(i>600&&snapshot.stats.active+snapshot.stats.queued===0)break;
  }
  snapshot=simulation.snapshot();
  assert.equal(snapshot.stats.requested,31,label);
  assert.equal(snapshot.stats.arrived,31,label);
  assert.equal(snapshot.stats.active+snapshot.stats.queued,0,label);
  assert.equal(snapshot.stats.turnLaneBlocked,0,label);
  assert.equal(snapshot.stats.safetyCorrections,0,label);
  return snapshot;
}

for(const name of ['fork','signal'])test(`unknown-exit exploration clears ${name} without illegal turns or body overlap`,()=>{
  exploreAndDrain(createPreset(name),name);
});

test('unknown-exit drivers explore and return from an actual dead end',()=>{
  const network=branchNetwork(false),snapshot=exploreAndDrain(network,'physical dead end');
  assert.ok(junctionConnections(network).some(connection=>connection.nodeId==='D'&&connection.uTurn));
  assert.ok(snapshot.events.some(event=>event.type==='junction-enter'&&event.nodeId==='D'),'the branch must actually be explored');
  assert.ok(!snapshot.events.some(event=>event.type==='junction-enter'&&event.nodeId==='S'),'exploration must not reverse into the source');
});

test('unknown-exit drivers avoid a mixed-direction branch with no legal onward movement',()=>{
  const network=branchNetwork(true),snapshot=exploreAndDrain(network,'mixed-direction branch');
  assert.ok(!junctionConnections(network).some(connection=>connection.nodeId==='D'&&connection.uTurn));
  assert.ok(!snapshot.events.some(event=>event.type==='junction-enter'&&event.nodeId==='D'));
});
