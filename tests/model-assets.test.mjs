import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {VEHICLE_TYPES} from '../src/simulation.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const serverEntry=existsSync(new URL('../scripts/serve.mjs',import.meta.url))?'scripts/serve.mjs':'server/serve.mjs';
const assets=[...VEHICLE_TYPES.map(type=>`vehicles/${type.id}.glb`),'props/signal_pole_3light.glb','props/street_lamp.glb'];
// Three's FileLoader reports browser progress while streaming HTTP responses.
if(!globalThis.ProgressEvent)globalThis.ProgressEvent=class ProgressEvent extends Event{
  constructor(type,values={}){super(type);Object.assign(this,values);}
};
async function freePort(){const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
async function serve(directory){
  const port=await freePort(),child=spawn(process.execPath,[serverEntry,'--root',directory,'--port',String(port)],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(new Error(`预览服务启动超时：${output}`)),10000);child.stdout.on('data',chunk=>{output+=chunk;if(output.includes(`:${port}/`)){clearTimeout(timer);resolve();}});child.stderr.on('data',chunk=>output+=chunk);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);reject(new Error(`预览服务提前退出 ${code}：${output}`));});});
  return {url:`http://127.0.0.1:${port}/`,close:()=>new Promise(resolve=>{child.once('exit',resolve);child.kill();})};
}
function verifyScene(gltf,name){
  let meshes=0;gltf.scene.updateMatrixWorld(true);gltf.scene.traverse(object=>{
    if(!object.isMesh)return;meshes++;const position=object.geometry.getAttribute('position');assert(position?.count>0,`${name} 含空模型`);
    for(let i=0;i<position.count;i++)assert(Number.isFinite(position.getX(i))&&Number.isFinite(position.getY(i))&&Number.isFinite(position.getZ(i)),`${name} 含无效顶点`);
  });assert(meshes>0,`${name} 缺少可渲染网格`);
}
test('all shipped GLB files parse with the real Three loader',async()=>{
  for(const name of assets){const bytes=await readFile(new URL('../assets/'+name,import.meta.url));const gltf=await new Promise((resolve,reject)=>new GLTFLoader().parse(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'',resolve,reject));verifyScene(gltf,name);}
});
test('source and built HTTP servers deliver every model intact and loadable',async()=>{
  for(const directory of ['.','dist']){const server=await serve(directory);try{
    for(const name of assets){const url=new URL('assets/'+name,server.url),response=await fetch(url);assert.equal(response.status,200,`${directory} ${name} HTTP 状态`);const bytes=Buffer.from(await response.arrayBuffer()),source=await readFile(new URL('../assets/'+name,import.meta.url));assert.deepEqual(bytes,source,`${directory} ${name} HTTP 资源内容与源码不同`);const gltf=await new GLTFLoader().loadAsync(url.href);verifyScene(gltf,`${directory} ${name}`);}
  }finally{await server.close();}}
});
