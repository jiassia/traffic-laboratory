import {makePath,pathPointAt} from './geometry.mjs';
import {solveBraess} from './classic-models.mjs';

const topics={
  braess:{name:'捷径与拥堵',title:'增加捷径，也可能增加等待',text:'车辆各自选择更快的路线，可能共同挤入相同路段。切换下方方案，观察路线如何集中。'},
  bottleneck:{name:'瓶颈排队',title:'进入得更快，队列就会增长',text:'当到达车辆超过瓶颈能放行的数量，队列开始积累。需求回落后，原来的队列还需要一段时间才能消散。'},
  signal:{name:'信号配时',title:'轮流放行，分配路口时间',text:'两个方向交替获得通行时间。延长一个方向的绿灯，会减少另一个方向的可用时间。'}
};
const car=(id,color='#4f9070')=>`<rect id="${id}" x="-7" y="-4" width="14" height="8" rx="2" fill="${color}"/>`;
const node=(x,y,name)=>`<circle cx="${x}" cy="${y}" r="16" fill="white" stroke="#a3bbaa"/><text x="${x}" y="${y+6}" text-anchor="middle" fill="#52715b" font-size="18">${name}</text>`;
export class TheoryGuide{
  constructor(setPanel){this.setPanel=setPanel;this.id='braess';this.variant='closed';this.time=0;this.paused=false;this.last=null;}
  open(id=this.id){this.id=id;this.time=0;this.last=null;this.paused=false;const t=topics[id];
    this.setPanel('交通原理',`<nav class="theory-tabs" aria-label="选择交通原理">${Object.entries(topics).map(([key,x])=>`<button data-theory-tab="${key}" class="${key===id?'active':''}">${x.name}</button>`).join('')}</nav><h3>${t.title}</h3><p>${t.text}</p><div class="theory-animation" data-theory="${id}">${this.diagram()}</div>${id==='braess'?`<div class="theory-variants"><button data-theory-variant="closed" class="${this.variant==='closed'?'active':''}">无捷径</button><button data-theory-variant="open" class="${this.variant==='open'?'active':''}">有捷径</button></div>`:''}<div class="theory-status" id="theory-status"></div><p class="theory-caption">循环示意动画。画布中的车辆与统计单独运行。</p>`,'<div class="theory-footer"><button data-action="theory-pause">暂停动画</button><button data-action="close-panel">返回画布</button></div>');
    this.update(performance.now());
  }
  diagram(){
    let drawing='';
    if(this.id==='braess'){
      drawing=`<path d="M35 140 180 45 325 140 180 235Z" fill="none" stroke="#d5e0d7" stroke-width="15" stroke-linejoin="round"/>${this.variant==='open'?'<path d="M180 45V235" stroke="#c58b52" stroke-width="12"/>':''}${Array.from({length:10},(_,i)=>car('theory-car-'+i,i%2?'#6c9a80':'#397a5a')).join('')}${node(35,140,'S')}${node(180,45,'A')}${node(180,235,'B')}${node(325,140,'T')}`;
      const S={x:35,z:140},A={x:180,z:45},B={x:180,z:235},T={x:325,z:140};this.paths=[makePath([S,A,T]),makePath([S,B,T]),makePath([S,A,B,T])];
    }else if(this.id==='bottleneck'){
      drawing=`<path d="M15 140H215L255 140H345" fill="none" stroke="#d4dfd6" stroke-width="36"/><path d="M255 140H345" stroke="#aac0af" stroke-width="20"/><path d="M20 140H235" stroke="white" stroke-dasharray="8 7"/><text x="255" y="108" fill="#718673" font-size="18">瓶颈</text>${Array.from({length:8},(_,i)=>car('queue-car-'+i)).join('')}${car('incoming-car')}${car('outgoing-car','#b78a5e')}`;
    }else{
      drawing=`<path d="M15 140H345M180 15V265" stroke="#d6e1d7" stroke-width="35"/><path d="M15 140H345M180 15V265" stroke="white" stroke-dasharray="8 7"/><circle id="theory-light-ew" cx="144" cy="109" r="11"/><circle id="theory-light-ns" cx="212" cy="106" r="11"/>${car('ew-car')}${car('ns-car','#b78960')}<text x="21" y="104" fill="#6c8170" font-size="18">东西</text><text x="209" y="38" fill="#6c8170" font-size="18">南北</text>`;
    }
    return `<svg viewBox="0 0 360 280" role="img" aria-label="${topics[this.id].name}循环动画">${drawing}</svg>`;
  }
  toggle(){this.paused=!this.paused;this.last=null;const b=document.querySelector('[data-action="theory-pause"]');if(b)b.textContent=this.paused?'继续动画':'暂停动画';}
  move(id,x,y,angle=0,visible=true){const el=document.getElementById(id);if(!el)return;el.setAttribute('transform',`translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${angle.toFixed(1)})`);el.style.opacity=visible?'1':'0';}
  update(now){
    if(this.last!==null&&!this.paused)this.time+=Math.min(.1,(now-this.last)/1000);this.last=now;
    const status=document.getElementById('theory-status');if(!status)return;
    if(this.id==='braess'){
      const open=this.variant==='open',r=solveBraess(4000);for(let i=0;i<10;i++){const p=this.paths[open?2:i%2],fraction=(this.time/(open?8:6.5)+Math.floor(i/2)/5+(open&&i%2?.1:0))%1,pos=pathPointAt(p,fraction*p.length);this.move('theory-car-'+i,pos.x,pos.z,90-pos.yaw*180/Math.PI);}
      status.textContent=`固定需求示例：${open?'有捷径':'无捷径'}，均衡用时 ${(open?r.with:r.without).meanTravelMinutes} 分钟`;
    }else if(this.id==='bottleneck'){
      const cycle=this.time%16,high=cycle<8,q=high?Math.floor(cycle):Math.max(0,Math.ceil(8-(cycle-8)*1.3));for(let i=0;i<8;i++)this.move('queue-car-'+i,228-i*22,140,0,i<q);
      this.move('incoming-car',20+(this.time%2)/2*Math.max(10,180-q*19),140);this.move('outgoing-car',270+(this.time%2)/2*72,140);status.textContent=high?'到达较多，队列逐渐增加':'需求回落，队列逐渐消散';
    }else{
      const phase=this.time%10,ew=phase<5;document.getElementById('theory-light-ew').setAttribute('fill',ew?'#4f9769':'#cd7666');document.getElementById('theory-light-ns').setAttribute('fill',ew?'#cd7666':'#4f9769');
      const progress=(this.time%5)/5;this.move('ew-car',ew?25+progress*310:135,140);this.move('ns-car',180,ew?95:20+progress*245,90);status.textContent=ew?'东西放行，南北等待':'南北放行，东西等待';
    }
  }
}
