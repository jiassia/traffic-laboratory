import test from 'node:test';
import assert from 'node:assert/strict';
import {cornerBends,vehicleFootprint} from '../src/junction-design.mjs';
import {junctionConnections} from '../src/simulation.mjs';
import {roadWidth,LANE_WIDTH} from '../src/lanes.mjs';
import {roadPointAt,roadPath} from '../src/geometry.mjs';

function contains(p,polygon){
  let inside=false;
  for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
    const a=polygon[j],b=polygon[i],dx=b.x-a.x,dz=b.z-a.z,qx=p.x-a.x,qz=p.z-a.z,along=qx*dx+qz*dz;
    if(dx*dx+dz*dz<1e-16)continue;
    if(Math.abs(dx*qz-dz*qx)<1e-6&&along>=-1e-6&&along<=dx*dx+dz*dz+1e-6)return true;
    if((a.z>p.z)!==(b.z>p.z)&&p.x<(b.x-a.x)*(p.z-a.z)/(b.z-a.z)+a.x)inside=!inside;
  }
  return inside;
}

test('ordinary bends do not widen by more than one lane beyond their adjoining roads',()=>{
  for(const degrees of [30,60,90,125])for(const [incoming,outgoing] of [[2,2],[3,1],[1,3]]){
    const angle=degrees*Math.PI/180;
    const network={version:1,nodes:[{id:'s',x:-180,z:0},{id:'j',x:0,z:0},{id:'t',x:180*Math.cos(angle),z:180*Math.sin(angle)}],
      roads:[{id:'in',a:'s',b:'j',oneWay:true,lanesForward:incoming,lanesBackward:0,type:'local',speedLimit:50},
        {id:'out',a:'j',b:'t',oneWay:true,lanesForward:outgoing,lanesBackward:0,type:'local',speedLimit:50}],source:'s',sink:'t',signals:{},facilities:[]};
    const bend=cornerBends(network,0,junctionConnections(network)).get('j');
    assert.ok(bend.smoothGeometry,`${degrees}: smooth road boundary`);
    assert.ok(bend.coverageComplete,`${degrees}, ${incoming} to ${outgoing}: complete clearance envelope`);
    const maximum=Math.max(...network.roads.map(roadWidth))+LANE_WIDTH;
    for(let i=0;i<bend.surfaceOuter.length;i++){
      const a=bend.surfaceOuter[i],b=bend.surfaceInner[i],width=Math.hypot(a.x-b.x,a.z-b.z);
      assert.ok(width<=maximum,`${degrees} degrees, ${incoming} to ${outgoing} lanes: ${width.toFixed(2)}m > ${maximum.toFixed(2)}m`);
    }
    const surfaces=[bend.polygon,...network.roads.map(r=>{
      const path=roadPath(network,r),trim=r.id===bend.roadA.id?bend.renderTrimA:bend.renderTrimB;
      const start=r.a==='j'?trim:0,end=path.length-(r.b==='j'?trim:0),half=roadWidth(r)/2;
      return [roadPointAt(network,r,start,-half),roadPointAt(network,r,start,half),roadPointAt(network,r,end,half),roadPointAt(network,r,end,-half)];
    })];
    for(const c of junctionConnections(network).filter(c=>c.nodeId==='j'))for(const pose of c.points){
      for(const p of vehicleFootprint(pose,10.923,3.0224,.02))assert.ok(surfaces.some(poly=>contains(p,poly)),`${degrees} degrees, ${incoming} to ${outgoing}: bus outside pavement at ${p.x.toFixed(2)}, ${p.z.toFixed(2)}`);
    }
  }
});
