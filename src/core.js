import {isMediaLayer,validateMediaLayer} from './media-core.js?v=0.3.1';
import {bezierProgress, validateCurve, DEFAULT_CURVE} from './curve.js?v=0.3.1';
// Original Filisi Motion project model and deterministic keyframe evaluation.
export const VERSION = 3;
export const PROPERTIES = ['x','y','scale','rotation','opacity','blur'];
export const EASINGS = {linear:t=>t, easeIn:t=>t*t*t, easeOut:t=>1-(1-t)**3, easeInOut:t=>t<.5?4*t*t*t:1-(-2*t+2)**3/2, hold:()=>0};
export const clone = value => JSON.parse(JSON.stringify(value));
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const uid = () => globalThis.crypto?.randomUUID?.() ?? `layer-${Date.now()}-${Math.random().toString(16).slice(2)}`;
export function makeLayer(type, duration=6) {
  return {id:uid(), type, name:({text:'文字',rect:'矩形',ellipse:'椭圆',image:'图片',video:'视频',audio:'音频'})[type],x:640,y:360,width:type==='text'?640:220,height:type==='text'?100:220,scale:1,rotation:0,opacity:1,blur:0,fill:'#a8eb73',radius:24,text:'让想法动起来',fontSize:72,fontWeight:700,align:'center',start:0,end:duration,visible:true,locked:false,blend:'source-over',keys:{}};
}
export function blankProject() { return {format:'filisi-motion',version:VERSION,name:'未命名合成',width:1280,height:720,duration:6,fps:30,background:'#121922',assets:[],layers:[]}; }
export function setKey(layer, property, time, value, easing='easeInOut', curve) {
  if (!PROPERTIES.includes(property) || !Number.isFinite(time) || !Number.isFinite(value)) throw Error('无效关键帧');
  const list=layer.keys[property]??=[]; const key=list.find(k=>Math.abs(k.time-time)<.0001);
  const next={time,value,easing};
  if(easing==='bezier')next.curve=validateCurve(curve??key?.curve??DEFAULT_CURVE);
  if(key){delete key.curve;Object.assign(key,next);}else list.push(next);
  list.sort((a,b)=>a.time-b.time);
}
export function valueAt(layer, property, time) {
  const keys=layer.keys[property]; if(!keys?.length) return layer[property];
  if(time<=keys[0].time) return keys[0].value;
  for(let i=1;i<keys.length;i++) if(time<=keys[i].time) {
    const a=keys[i-1],b=keys[i]; if(time===b.time)return b.value; const t=(time-a.time)/(b.time-a.time);
    return a.value+(b.value-a.value)*(a.easing==='bezier'?bezierProgress(t,a.curve):(EASINGS[a.easing]??EASINGS.linear)(t));
  }
  return keys.at(-1).value;
}
export function evaluated(layer,time) {const out={...layer}; for(const p of PROPERTIES) out[p]=valueAt(layer,p,time);return out;}
export function sampleProject() {
  const p=blankProject();p.name='在轨 · ORBIT';
  const add=(type,props)=>{const l=Object.assign(makeLayer(type),props);p.layers.push(l);return l;};
  const disk=add('ellipse',{name:'轨道 / 主形',x:953,y:356,width:414,height:414,fill:'#a8eb73'});
  setKey(disk,'scale',0,.15,'easeOut');setKey(disk,'scale',1.6,1);setKey(disk,'scale',4.5,1,'easeInOut');setKey(disk,'scale',6,.7);
  setKey(disk,'rotation',0,-40,'linear');setKey(disk,'rotation',6,60);
  const cut=add('ellipse',{name:'轨道 / 内环',x:953,y:356,width:252,height:252,fill:p.background});
  setKey(cut,'scale',0,.01,'easeOut');setKey(cut,'scale',1.8,1);setKey(cut,'scale',4.5,1);setKey(cut,'scale',6,.7);
  const bar=add('rect',{name:'穿过轨道',x:950,y:356,width:520,height:34,fill:'#f3f6ec',rotation:-38,radius:17});
  setKey(bar,'x',0,1430,'easeOut');setKey(bar,'x',1.8,950);setKey(bar,'rotation',0,-70,'easeInOut');setKey(bar,'rotation',6,-22);
  const title=add('text',{name:'标题 · 让想法动起来',text:'让想法\n动起来。',x:370,y:304,width:640,height:260,fontSize:98,align:'left',fill:'#f2f5ec'});
  setKey(title,'y',0,370,'easeOut');setKey(title,'y',1.3,304);setKey(title,'opacity',0,0,'easeOut');setKey(title,'opacity',.9,1);
  add('text',{name:'副标题',text:'A SMALL IDEA. A WORLD IN MOTION.',x:360,y:517,width:620,height:40,fontSize:22,fontWeight:400,align:'left',fill:'#9ca8ad',start:.7});
  add('text',{name:'片头标记',text:'FILISI  /  MOTION STUDY 001',x:355,y:115,width:610,height:30,fontSize:20,fontWeight:600,align:'left',fill:'#a8eb73'});
  const dot=add('ellipse',{name:'游走的点',x:1100,y:150,width:28,height:28,fill:'#fd9560'});
  setKey(dot,'x',0,760,'easeInOut');setKey(dot,'x',3,1130,'easeInOut');setKey(dot,'x',6,760);
  setKey(dot,'y',0,155,'easeInOut');setKey(dot,'y',3,570,'easeInOut');setKey(dot,'y',6,155);
  return p;
}
const finite=(n,min,max,label)=>{if(typeof n!=='number'||!Number.isFinite(n)||n<min||n>max) throw Error(`${label}超出范围`);return n;};
export function validateProject(raw) {
  if(!raw||raw.format!=='filisi-motion'||![1,2,VERSION].includes(raw.version)) throw Error('不是受支持的 Filisi Motion v1/v2/v3 工程');
  const p=blankProject();p.name=String(raw.name??'未命名合成').slice(0,120);
  p.width=finite(raw.width,64,3840,'宽度');p.height=finite(raw.height,64,2160,'高度');
  p.duration=finite(raw.duration,.1,300,'时长');p.fps=finite(raw.fps,1,60,'帧率');
  if(!Number.isInteger(p.width)||!Number.isInteger(p.height)||!Number.isInteger(p.fps))throw Error('尺寸和帧率须为整数');
  if(!/^#[a-f\d]{6}$/i.test(raw.background))throw Error('无效背景色');p.background=raw.background;
  const allowedMime=/^(video\/(mp4|webm|quicktime)|audio\/(mpeg|mp4|wav|x-wav|ogg|webm|flac))$/;
  const inputAssets=raw.assets??[];if(!Array.isArray(inputAssets)||inputAssets.length>32)throw Error('最多支持 32 个媒体素材');
  let assetBytes=0;const assetIds=new Set();p.assets=inputAssets.map(a=>{
    if(!a||!/^asset-[a-f0-9]{64}$/.test(a.id)||assetIds.has(a.id))throw Error('无效或重复的素材 ID');assetIds.add(a.id);
    if(!allowedMime.test(a.mime)||!['video','audio'].includes(a.type))throw Error('不支持的媒体素材类型');
    const out={id:a.id,name:String(a.name??'媒体').slice(0,180),mime:a.mime,type:a.type,size:finite(a.size,1,64*1024*1024,'素材大小'),duration:finite(a.duration,.001,7200,'素材时长'),width:finite(a.width??0,0,7680,'素材宽度'),height:finite(a.height??0,0,4320,'素材高度')};
    assetBytes+=out.size;if(assetBytes>128*1024*1024)throw Error('工程媒体总量超过 128 MB');
    if(a.data!==undefined){if(typeof a.data!=='string'||a.data.length>90*1024*1024||!a.data.startsWith('data:'+a.mime+';base64,')||!/^[a-z\d+/=]+$/i.test(a.data.split(',')[1]??''))throw Error('无效内嵌媒体');out.data=a.data;}
    return out;
  });
  if(!Array.isArray(raw.layers)||raw.layers.length>100)throw Error('最多支持 100 个图层');
  const ids=new Set();p.layers=raw.layers.map(v=>{
    if(!['rect','ellipse','text','image','video','audio'].includes(v.type))throw Error('未知图层类型');
    const l=makeLayer(v.type,p.duration);l.id=typeof v.id==='string'?v.id:uid();if(ids.has(l.id))throw Error('图层 ID 重复');ids.add(l.id);
    for(const key of ['name','text'])l[key]=String(v[key]??l[key]).slice(0,key==='text'?4000:120);
    const ranges={x:[-20000,20000],y:[-20000,20000],width:[1,20000],height:[1,20000],scale:[.01,20],rotation:[-36000,36000],opacity:[0,1],blur:[0,100],radius:[0,2000],fontSize:[1,1000],fontWeight:[100,900],start:[0,p.duration],end:[0,p.duration]};
    for(const [key,[min,max]]of Object.entries(ranges))l[key]=finite(v[key]??l[key],min,max,key);
    if(l.end<=l.start)throw Error('图层出点必须晚于入点');
    if(!/^#[a-f\d]{6}$/i.test(v.fill))throw Error('无效图层颜色');l.fill=v.fill;
    l.visible=v.visible!==false;l.locked=v.locked===true;l.align=['left','center','right'].includes(v.align)?v.align:'center';
    l.blend=['source-over','multiply','screen','overlay','lighter'].includes(v.blend)?v.blend:'source-over';
    if(v.type==='image') {if(typeof v.src!=='string'||v.src.length>14000000||!/^data:image\/(png|jpeg|webp);base64,[a-z\d+/=\s]+$/i.test(v.src))throw Error('图片须为内嵌 PNG、JPEG 或 WebP');l.src=v.src;}
    if(isMediaLayer(l)){
      l.assetId=String(v.assetId??'');const a=p.assets.find(a=>a.id===l.assetId);if(!a)throw Error('图层引用了缺失的媒体素材');
      if(l.type==='video'&&a.type!=='video')throw Error('视频图层必须引用视频素材');
      l.sourceIn=finite(v.sourceIn??0,0,7200,'源入点');l.mediaDuration=finite(v.mediaDuration??a.duration,.001,7200,'媒体时长');
      if(Math.abs(l.mediaDuration-a.duration)>.0001)throw Error('图层和素材时长不一致');
      l.volume=finite(v.volume??1,0,2,'音量');l.muted=v.muted===true;l.fadeIn=finite(v.fadeIn??0,0,300,'淡入');l.fadeOut=finite(v.fadeOut??0,0,300,'淡出');
      if(v.fadeOrigin!==undefined)l.fadeOrigin={sourceIn:finite(v.fadeOrigin?.sourceIn,0,7200,'渐变源入点'),duration:finite(v.fadeOrigin?.duration,.001,7200,'渐变范围')};
      validateMediaLayer(l);
    }
    for(const prop of PROPERTIES){const keys=v.keys?.[prop]??[];if(!Array.isArray(keys)||keys.length>1000)throw Error('关键帧数量过多');
      for(const k of keys)setKey(l,prop,finite(k.time,isMediaLayer(l)?-7200:0,isMediaLayer(l)?7200:p.duration,'关键帧时间'),finite(k.value,...ranges[prop],prop),k.easing==='bezier'?'bezier':Object.hasOwn(EASINGS,k.easing)?k.easing:'linear',k.easing==='bezier'?validateCurve(k.curve):undefined);}
    return l;
  });if(p.layers.filter(isMediaLayer).length>32)throw Error('最多支持 32 个媒体片段');return p;
}
export class History {
  constructor(limit=60){this.limit=limit;this.past=[];this.future=[];}
  push(p){this.past.push(clone(p));if(this.past.length>this.limit)this.past.shift();this.future=[];}
  undo(p){if(!this.past.length)return p;this.future.push(clone(p));return this.past.pop();}
  redo(p){if(!this.future.length)return p;this.past.push(clone(p));return this.future.pop();}
  clear(){this.past=[];this.future=[];}
}

