// Literature reference profiles, not per-model field calibration.
// maxSpeed is unconstrained desired free-flow speed in km/h, not a speed limit.
export const PARAMETER_SOURCES=Object.freeze([
  {id:'ACC2007',title:'Extending Adaptive Cruise Control to Adaptive Driving Strategies',authors:'Kesting, Treiber, Schönhof, Helbing',year:2007,doi:'10.3141/2000-03',url:'https://mtreiber.de/publications/ACC_TRB07.pdf',locator:'作者稿第12页 Table 2',status:'full-text-read; CrossRef metadata verified',scope:'汽车与卡车的高速路仿真参考参数组'},
  {id:'IDM2000',title:'Congested Traffic States in Empirical Observations and Microscopic Simulations',authors:'Treiber, Hennecke, Helbing',year:2000,doi:'10.1103/PhysRevE.62.1805',url:'https://arxiv.org/pdf/cond-mat/0002177',locator:'PDF第29页 Table I；第10页参数讨论',status:'full-text-read',scope:'同质车辆的高速路研究，作为模型结构与参数量纲依据'},
  {id:'IDM_AUTHOR',title:'The Intelligent-Driver Model and its Variants',authors:'Martin Treiber',url:'https://traffic-simulation.de/info/info_IDM.html',locator:'Model Parameters 与 Simulation of the Model',status:'full-text-read',scope:'作者说明：自由流期望速度、时距、停车间距和限速约束'},
  {id:'BUS_COMFORT',title:'The impact of a passenger-safety-driven acceleration limit on the operation of a bus service',authors:'Karekla, Gkiotsalitis, Tyler',doi:'10.1016/j.aap.2020.105790',url:'https://discovery.ucl.ac.uk/id/eprint/10120841/1/Karekla_OperationalBusCharacteristics_Accepted.pdf',locator:'作者接受稿第7页 Table 2；第14页 Table 4',status:'accepted-manuscript-read; publisher metadata request unavailable',scope:'伦敦单辆公交往返的观测与1.0 m/s²舒适目标，非所有公交的动力性能上限'},
  {id:'FHWA_WEATHER',title:'How Do Weather Events Affect Roads?',authors:'Federal Highway Administration',url:'https://ops.fhwa.dot.gov/weather/roadimpact.htm',locator:'Weather Effects on Mobility',status:'official-page-read',scope:'干道及高速公路天气影响的观测范围汇总'},
  {id:'FHWA_CALIBRATION',title:'Traffic Analysis Toolbox Volume III, Chapter 5: Model Calibration',authors:'Federal Highway Administration',year:2019,url:'https://ops.fhwa.dot.gov/publications/fhwahop18036/chapter5.htm',locator:'章节开头的校准定义与适用条件',status:'official-page-read',scope:'使用当地需求、轨迹、速度与排队数据进行校准的方法依据'}
]);

const passenger={maxSpeed:120,accel:1.4,brake:2,timeHeadway:1.5,minGap:2,sourceId:'ACC2007',group:'passenger'};
const lightCommercial={...passenger,group:'light-commercial-proxy',assumption:'缺少本项目轻型货车独立校准，暂采用汽车组参考参数。'};
const profiles={
  sedan:{...passenger},
  hatchback:{...passenger},
  suv:{...passenger,assumption:'SUV采用汽车组参考，未虚构车型专属速度差异。'},
  taxi:{...passenger,assumption:'出租车采用汽车组参考，未用车身类别推定激进驾驶。'},
  pickup:{...lightCommercial},
  van:{...lightCommercial},
  truck:{maxSpeed:85,accel:.7,brake:2,timeHeadway:2,minGap:2,sourceId:'ACC2007',group:'truck'},
  bus:{maxSpeed:80,accel:1,brake:1,timeHeadway:2,minGap:2,sourceId:'BUS_COMFORT',group:'bus-comfort',assumption:'加速与舒适制动采用1.0 m/s²目标；自由流速度80 km/h、时距2 s、停车间距2 m为大车代理工程选择，非公交论文校准结果。紧急制动应另行处理。'}
};
export const VEHICLE_PROFILES=Object.freeze(Object.fromEntries(Object.entries(profiles).map(([id,p])=>[id,Object.freeze(p)])));

// friction is an engineering braking multiplier, NOT a measured tyre/road coefficient.
// visibility is an illustrative available sight distance, NOT calibrated local weather data.
export const WEATHER_REFERENCE=Object.freeze({
  clear:Object.freeze({speedFactor:1,friction:1,visibility:180,sourceId:null,scope:'基准条件',assumption:'制动倍率和可用视距为工程初值。'}),
  rain:Object.freeze({speedFactor:.825,friction:.68,visibility:100,sourceId:'FHWA_WEATHER',speedReductionRange:[.10,.25],scope:'湿路面城市干道速度下降10%至25%，倍率取范围中点。',assumption:'雨量等级、制动倍率.68与100m视距未做当地校准。'}),
  snow:Object.freeze({speedFactor:.65,friction:.4,visibility:70,sourceId:'FHWA_WEATHER',speedReductionRange:[.30,.40],scope:'积雪或雪泥干道速度下降30%至40%，倍率取范围中点。',assumption:'雪深、制动倍率.4与70m视距未做当地校准。'}),
  fog:Object.freeze({speedFactor:.89,friction:.9,visibility:45,sourceId:'FHWA_WEATHER',speedReductionRange:[.10,.12],scope:'高速公路低能见度平均速度下降10%至12%，仅作参考，不是城市雾天统一统计。',assumption:'制动倍率.9与45m视距为工程情景，额外视距限速可能主导实际速度。'})
});
