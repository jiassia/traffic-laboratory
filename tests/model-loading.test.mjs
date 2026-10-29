import test from 'node:test';
import assert from 'node:assert/strict';
import {loadModelWithRetry} from '../src/model-loading.mjs';

test('transient model request recovers on a bounded retry',async()=>{
  let calls=0;const waits=[];
  const loaded=await loadModelWithRetry(async()=>{if(++calls<3)throw new TypeError('Failed to fetch');return 'model';},'lamp.glb',{wait:async ms=>waits.push(ms)});
  assert.equal(loaded,'model');assert.equal(calls,3);assert.deepEqual(waits,[350,1000]);
});
test('missing or malformed assets report the original error without retry',async()=>{
  for(const message of ['fetch responded with 404','THREE.GLTFLoader: Unsupported asset version']){
    let calls=0;const error=new Error(message);
    await assert.rejects(loadModelWithRetry(async()=>{calls++;throw error;},'lamp.glb'),caught=>caught===error);
    assert.equal(calls,1);
  }
});
test('persistent transient failure stops after three attempts and preserves details',async()=>{
  let calls=0;const error=new Error('HTTP 503');
  await assert.rejects(loadModelWithRetry(async()=>{calls++;throw error;},'lamp.glb',{wait:async()=>{}}),caught=>caught===error);
  assert.equal(calls,3);
});
