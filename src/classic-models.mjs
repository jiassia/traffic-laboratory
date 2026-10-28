import {emptyNetwork,parseDesign} from './simulation.mjs';
import {autoPlaceFacilities} from './network.mjs';
import {sampleCubic} from './geometry.mjs';

const finite=(value,min,max,label)=>{
  if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)throw new Error(`${label}应为 ${min} 至 ${max} 之间的有限数值`);
  return value;
};
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const EPS=1e-8;
const CORNELL={title:'Easley 与 Kleinberg：Networks, Crowds, and Markets，第 8 章',url:'https://www.cs.cornell.edu/home/kleinber/networks-book/'};
const FHWA_SIGNAL={title:'FHWA Traffic Signal Timing Manual：交叉口容量与有效绿灯',url:'https://ops.fhwa.dot.gov/publications/fhwahop08024/chapter3.htm'};
const FHWA_TRAFFIC={title:'FHWA Traffic Analysis Toolbox：模型验证、校准与方案比较',url:'https://ops.fhwa.dot.gov/publications/fhwahop18036/index.htm'};

export const CLASSIC_MODELS=Object.freeze([
  {
    id:'braess',title:'布雷斯悖论',subtitle:'比较关闭与开放捷径后的均衡出行时间',
    theory:'静态 Wardrop 用户均衡。两条拥挤边的成本为 x/100 分钟，两条固定边为 45 分钟，捷径为 0 分钟。正流量路线具有相同且最低的成本。',
    variants:[{id:'closed',label:'关闭捷径'},{id:'open',label:'开放捷径'}],
    parameters:[{key:'demand',label:'总需求',unit:'辆/模型期',min:0,max:12000,step:100,default:4000}],
    references:[CORNELL],
    notes:['流量是同一模型期内的连续需求，不是每秒入场量，也不是屏幕中同时出现的车辆数。','结果由四节点成本函数与均衡条件计算。画布另加独立入口与出口引道，物理图共六节点；引道不加入理论求解。','物理路网动画使用另一套跟车、路权和随机行为模型，微观 HUD 不读取此处分钟数。','需求为 0 时显示无需求，不构成旅行时间样本。'],
  },
  {
    id:'bottleneck',title:'瓶颈排队与疏散',subtitle:'观察高峰排队形成及需求回落后的清空过程',
    theory:'确定性点队列。累计到达减去累计离开等于当前队列；队列非空时按瓶颈容量放行，队列不能为负。高峰后使用独立恢复需求。',
    variants:[{id:'base',label:'原始瓶颈'},{id:'improved',label:'提高通行能力'}],
    parameters:[
      {key:'demand',label:'高峰需求',unit:'辆/小时',min:0,max:7200,step:60,default:1800},
      {key:'capacity',label:'瓶颈容量',unit:'辆/小时',min:0,max:7200,step:60,default:1200},
      {key:'duration',label:'高峰时长',unit:'分钟',min:0,max:120,step:1,default:30},
      {key:'recoveryDemand',label:'恢复期需求',unit:'辆/小时',min:0,max:7200,step:60,default:0},
      {key:'recoveryDuration',label:'恢复期时长',unit:'分钟',min:0,max:120,step:1,default:20},
    ],
    references:[FHWA_TRAFFIC],
    notes:['这是连续流量的点队列，不计算车身长度、道路储车空间、回堵传播或车道变换。','总排队延误是队列长度随时间的积分，单位为车·分钟；它包含观测窗口内尚未离开的车辆已等待时间。','画布中的改造示例改变道路限速和几何配置，不能据此将微观吞吐量强行指定为理论容量。'],
  },
  {
    id:'signal',title:'信号绿灯分配',subtitle:'比较固定周期内两个方向的通行能力',
    theory:'单进口方向的容量近似 c=s×n×g/C。s 为每车道饱和流率，n 为车道数，g 为有效绿灯，C 为周期。',
    variants:[{id:'balanced',label:'东西南北均衡'},{id:'adjusted',label:'调整东西绿灯'}],
    parameters:[
      {key:'green',label:'东西绿灯',unit:'秒',min:5,max:55,step:1,default:30},
      {key:'saturationFlow',label:'每车道饱和流率',unit:'辆/小时',min:300,max:2400,step:60,default:1800},
      {key:'lanes',label:'进口车道数',unit:'条',min:1,max:6,step:1,default:1},
      {key:'demand',label:'进口需求',unit:'辆/小时',min:0,max:7200,step:60,default:900},
    ],
    references:[FHWA_SIGNAL],
    notes:['均衡配时示例为东西 30 秒、南北 30 秒，每次黄灯 3 秒、全红 2 秒，合计 70 秒。','饱和流率是可调整的教学输入，不代表某一现实路口已经标定的能力。','均匀延误近似只适用于欠饱和及给定到达假设；过饱和时不输出伪造的有限稳态等待时间。'],
  },
]);

function equilibriumState(demand,flows,{congestionScale,fixedMinutes,shortcutMinutes},shortcutAvailable){
  const {upper,lower,shortcut}=flows;
  const edgeFlows=[
    {id:'SA',flow:upper+shortcut,costMinutes:(upper+shortcut)/congestionScale},
    {id:'AT',flow:upper,costMinutes:fixedMinutes},
    {id:'SB',flow:lower,costMinutes:fixedMinutes},
    {id:'BT',flow:lower+shortcut,costMinutes:(lower+shortcut)/congestionScale},
    ...(shortcutAvailable?[{id:'AB',flow:shortcut,costMinutes:shortcutMinutes}]:[]),
  ];
  const costs=Object.fromEntries(edgeFlows.map(edge=>[edge.id,edge.costMinutes]));
  const routeCosts={upper:costs.SA+costs.AT,lower:costs.SB+costs.BT,shortcut:shortcutAvailable?costs.SA+shortcutMinutes+costs.BT:null};
  const used=Object.entries(flows).filter(([id,flow])=>flow>EPS&&routeCosts[id]!==null);
  const available=Object.values(routeCosts).filter(value=>value!==null);
  const minimumCost=Math.min(...available);
  const totalTravelVehicleMinutes=Object.entries(flows).reduce((sum,[id,flow])=>sum+flow*(routeCosts[id]??0),0);
  const meanTravelMinutes=demand>0?totalTravelVehicleMinutes/demand:null;
  const usedCostError=used.reduce((error,[id])=>Math.max(error,Math.abs(routeCosts[id]-minimumCost)),0);
  const balanceError=Math.abs(upper+lower+shortcut-demand);
  return {pathFlows:{...flows},routeCosts,meanTravelMinutes,totalTravelVehicleMinutes,edgeFlows,equilibriumError:Math.max(usedCostError,balanceError),balanceError,minimumRouteMinutes:minimumCost};
}

/** Symmetric four-node Braess network; all values follow the stated cost functions. */
export function solveBraess(demand=4000,options={}){
  finite(demand,0,1000000,'总需求');
  const parameters={congestionScale:100,fixedMinutes:45,shortcutMinutes:0,...options};
  finite(parameters.congestionScale,.001,1000000,'拥挤成本分母');finite(parameters.fixedMinutes,0,10000,'固定道路成本');finite(parameters.shortcutMinutes,0,10000,'捷径成本');
  const without=equilibriumState(demand,{upper:demand/2,lower:demand/2,shortcut:0},parameters,false);
  // At an interior equilibrium, direct and shortcut routes have equal cost:
  // (N+w)/(2a) + b = (N+w)/a + c, hence w=2a(b-c)-N.
  const shortcut=clamp(2*parameters.congestionScale*(parameters.fixedMinutes-parameters.shortcutMinutes)-demand,0,demand);
  const withShortcut=equilibriumState(demand,{upper:(demand-shortcut)/2,lower:(demand-shortcut)/2,shortcut},parameters,true);
  const differenceMinutes=demand>0?withShortcut.meanTravelMinutes-without.meanTravelMinutes:null;
  const changePercent=differenceMinutes===null||without.meanTravelMinutes===0?null:differenceMinutes/without.meanTravelMinutes*100;
  return {
    modelId:'braess-static-v1',demand,hasDemand:demand>0,parameters,without,with:withShortcut,differenceMinutes,changePercent,
    status:demand===0?'no-demand':Math.abs(differenceMinutes)<=EPS?'equal':differenceMinutes<0?'improved':'worse',
    notes:[...CLASSIC_MODELS[0].notes,'本模块求解对称、连续、非原子需求的用户均衡，不求解任意路网，也不把理论分钟数写入车辆动画。'],
  };
}

function queueInterval(queue,arrivalRate,capacity,minutes){
  const inflow=arrivalRate/60,service=capacity/60,change=inflow-service;
  const arrived=inflow*minutes;
  if(change>=0){const next=queue+change*minutes;return{queue:next,arrived,served:service*minutes,area:(queue+next)*minutes/2};}
  const clearingTime=queue/(-change);
  if(clearingTime>=minutes){const next=Math.max(0,queue+change*minutes);return{queue:next,arrived,served:service*minutes,area:(queue+next)*minutes/2};}
  return{queue:0,arrived,served:queue+arrived,area:queue*clearingTime/2};
}

/** Fluid FIFO point queue with a peak phase and an explicit recovery phase. */
export function simulateBottleneck({demand=1800,capacity=1200,duration=30,initialQueue=0,recoveryDemand=0,recoveryDuration=20,stepSeconds=30}={}){
  finite(demand,0,100000,'高峰需求');finite(capacity,0,100000,'瓶颈容量');finite(duration,0,1440,'高峰时长');finite(initialQueue,0,1000000,'初始队列');finite(recoveryDemand,0,100000,'恢复期需求');finite(recoveryDuration,0,1440,'恢复期时长');finite(stepSeconds,.1,300,'计算采样间隔');
  if((duration+recoveryDuration)*60/stepSeconds>200000)throw new Error('采样点过多，请增大计算间隔');
  const parameters={demand,capacity,duration,initialQueue,recoveryDemand,recoveryDuration,stepSeconds};
  let time=0,queue=initialQueue,arrived=0,totalServed=0,totalDelayVehicleMinutes=0,maxQueue=queue,clearedAt=null;
  const series=[{time:0,queue,arrivals:0,departures:0,demand:duration>0?demand:recoveryDemand,capacity}];
  const phases=[{minutes:duration,rate:demand,recovery:false},{minutes:recoveryDuration,rate:recoveryDemand,recovery:true}];
  for(const phase of phases){
    let elapsed=0;
    while(elapsed<phase.minutes-EPS){
      const minutes=Math.min(stepSeconds/60,phase.minutes-elapsed),before=queue,result=queueInterval(queue,phase.rate,capacity,minutes);
      if(clearedAt===null&&before>0&&result.queue<=EPS&&capacity>phase.rate)clearedAt=time+before/((capacity-phase.rate)/60);
      queue=result.queue;arrived+=result.arrived;totalServed+=result.served;totalDelayVehicleMinutes+=result.area;maxQueue=Math.max(maxQueue,queue);elapsed+=minutes;time+=minutes;
      series.push({time,queue,arrivals:arrived,departures:totalServed,demand:phase.rate,capacity});
    }
  }
  const additionalClearanceMinutes=queue<=EPS?0:capacity>0?queue/(capacity/60):null;
  return {
    modelId:'point-queue-v1',parameters,arrived,totalServed,remainingQueue:queue,maxQueue,totalDelayVehicleMinutes,
    clearanceMinutes:additionalClearanceMinutes,clearedAtMinute:clearedAt,averageQueue:time>0?totalDelayVehicleMinutes/time:queue,
    series,balanceError:Math.abs(initialQueue+arrived-totalServed-queue),
    notes:[...CLASSIC_MODELS[1].notes,'额外清空时间假设从观测终点起停止新增需求，并维持当前容量；容量为 0 且仍有排队时返回 null。'],
  };
}

/** Capacity and undersaturated uniform-delay approximation for one approach group. */
export function signalCapacity({saturationFlow=1800,lanes=1,green=30,red=40,yellow=0,allRed=0,lostTime=0,demand=900}={}){
  finite(saturationFlow,0,10000,'每车道饱和流率');finite(lanes,1,12,'进口车道数');if(!Number.isInteger(lanes))throw new Error('进口车道数必须为整数');
  finite(green,0,3600,'绿灯时长');finite(red,0,3600,'红灯时长');finite(yellow,0,300,'黄灯时长');finite(allRed,0,300,'全红时长');finite(lostTime,0,300,'绿灯损失时间');finite(demand,0,100000,'进口需求');
  const cycleSeconds=green+red+yellow+allRed;if(cycleSeconds<=0)throw new Error('信号周期必须大于 0 秒');
  const effectiveGreenSeconds=Math.max(0,green-lostTime),greenRatio=effectiveGreenSeconds/cycleSeconds,capacityVehPerHour=saturationFlow*lanes*greenRatio;
  const degreeOfSaturation=capacityVehPerHour>0?demand/capacityVehPerHour:demand===0?0:null;
  const stability=capacityVehPerHour<=0?'blocked':Math.abs(demand-capacityVehPerHour)<=EPS?'critical':demand<capacityVehPerHour?'stable':'oversaturated';
  let uniformDelaySeconds=null;
  if(demand===0)uniformDelaySeconds=0;
  else if(stability==='stable')uniformDelaySeconds=.5*cycleSeconds*(1-greenRatio)**2/(1-degreeOfSaturation*greenRatio);
  return {
    modelId:'signal-capacity-v1',cycleSeconds,effectiveGreenSeconds,capacityVehPerHour,degreeOfSaturation,uniformDelaySeconds,
    queueGrowthVehPerHour:Math.max(0,demand-capacityVehPerHour),stability,greenRatio,
    notes:[...CLASSIC_MODELS[2].notes,'均匀延误是固定周期、均匀到达假设下的近似项，未计随机溢流、初始排队、下游回堵或多方向冲突容量。'],
  };
}

function normalizeVariant(id,variant){
  const aliases=id==='braess'?{closed:'closed',open:'open','without-shortcut':'closed','with-shortcut':'open'}:id==='bottleneck'?{base:'base',improved:'improved'}:{balanced:'balanced',adjusted:'adjusted'};
  const fallback=id==='braess'?'closed':id==='bottleneck'?'base':'balanced',result=aliases[variant??fallback];if(!result)throw new Error('未找到此经典实验的路网变体');return result;
}

/** Independent physical examples. Their geometry is not a conversion of theoretical costs. */
export function createClassicNetwork(id,variant,options={}){
  if(!CLASSIC_MODELS.some(model=>model.id===id))throw new Error('未找到此经典实验');const selected=normalizeVariant(id,variant),network=emptyNetwork();
  const edge=(edgeId,a,b,{points,type='local',speedLimit=50,oneWay=false}={})=>network.roads.push({id:edgeId,a,b,type,speedLimit,oneWay,...(points?{points,shape:'curve'}:{shape:'straight'})});
  if(id==='braess'){
    network.nodes=[{id:'G_IN',x:-240,z:0},{id:'S',x:-160,z:0},{id:'A',x:-60,z:-55},{id:'B',x:60,z:55},{id:'T',x:160,z:0},{id:'G_OUT',x:240,z:0}];const byId=Object.fromEntries(network.nodes.map(node=>[node.id,node]));
    edge('GATE_IN','G_IN','S',{oneWay:true});
    edge('SA','S','A',{oneWay:true});
    edge('AT','A','T',{oneWay:true,points:sampleCubic(byId.A,{x:140,z:-250},{x:280,z:-160},byId.T,64)});
    edge('SB','S','B',{oneWay:true,points:sampleCubic(byId.S,{x:-280,z:160},{x:-140,z:250},byId.B,64)});
    edge('BT','B','T',{oneWay:true});if(selected==='open')edge('AB','A','B',{oneWay:true});edge('GATE_OUT','T','G_OUT',{oneWay:true});network.source='G_IN';network.sink='G_OUT';
  }else if(id==='bottleneck'){
    network.nodes=[{id:'S',x:-150,z:0},{id:'A',x:-50,z:0},{id:'B',x:50,z:0},{id:'T',x:150,z:0}];
    edge('entry','S','A',{oneWay:true});edge('bottleneck','A','B',{type:selected==='base'?'slow':'main',speedLimit:selected==='base'?20:60});edge('exit','B','T',{oneWay:true});network.source='S';network.sink='T';
  }else{
    const green=selected==='balanced'?30:options.green??45;finite(green,5,55,'东西绿灯');
    network.nodes=[{id:'S',x:-140,z:0},{id:'J',x:0,z:0},{id:'T',x:140,z:0},{id:'N',x:0,z:-100},{id:'D',x:0,z:100}];
    edge('west','S','J',{oneWay:true});edge('east','J','T',{oneWay:true});edge('north','N','J');edge('south','J','D');network.source='S';network.sink='T';
    network.signals.J={enabled:true,greenEW:green,greenNS:60-green,yellow:3,allRed:2,offset:0};
  }
  const decorated=autoPlaceFacilities(network,{streetlights:true,trafficLights:id==='signal',spacing:45});
  return parseDesign(JSON.stringify({network:decorated})).network;
}
