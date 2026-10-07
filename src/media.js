// Original media scheduling. Browser decoders are asynchronous; no private source is fetched.
import {isMediaLayer,activeAt,sourceTimeAt,audioEnvelope} from './media-core.js?v=0.4.0';
import {mediaWorkingSet,mediaPlanKey} from './media-plan.js?v=0.4.0';
const abort=()=>new DOMException('A newer media request replaced this one','AbortError');
export const hasMedia=project=>project.layers.some(isMediaLayer);
function loaded(element,signal){return new Promise((resolve,reject)=>{if(signal?.aborted)return reject(abort());if(element.readyState>=1)return resolve();let timer;
 const finish=error=>{clearTimeout(timer);element.removeEventListener('loadedmetadata',ok);element.removeEventListener('error',fail);signal?.removeEventListener('abort',cancel);error?reject(error):resolve();};
 const ok=()=>finish();const fail=()=>finish(Error('浏览器不支持此素材的编码'));const cancel=()=>finish(abort());element.addEventListener('loadedmetadata',ok,{once:true});element.addEventListener('error',fail,{once:true});signal?.addEventListener('abort',cancel,{once:true});timer=setTimeout(()=>finish(Error('媒体加载超时')),12000);
});}
function disposeEntry(entry){entry.cancelSeek?.();entry.loading?.abort();entry.element.pause();entry.source?.disconnect();entry.gain?.disconnect();entry.element.removeAttribute('src');entry.element.load();}
function seekElement(entry,seconds){entry.cancelSeek?.();const e=entry.element,target=Math.min(Math.max(0,seconds),Math.max(0,e.duration-.001));
 if(Math.abs(e.currentTime-target)<.004&&!e.seeking&&e.readyState>=2)return Promise.resolve();
 return new Promise((resolve,reject)=>{let timer;const finish=error=>{clearTimeout(timer);e.removeEventListener('seeked',check);e.removeEventListener('loadeddata',check);e.removeEventListener('error',fail);entry.cancelSeek=null;error?reject(error):resolve();};const check=()=>{if(!e.seeking&&e.readyState>=2&&Math.abs(e.currentTime-target)<.06)finish();};const fail=()=>finish(Error('媒体定位失败'));entry.cancelSeek=()=>finish(abort());e.addEventListener('seeked',check);e.addEventListener('loadeddata',check);e.addEventListener('error',fail,{once:true});timer=setTimeout(()=>finish(Error('媒体定位超时，请使用较短的 H.264 MP4 素材')),8000);try{e.currentTime=target;check();}catch(err){finish(err);}});
}
export class MediaRuntime {
 constructor(store,{onError=()=>{}}={}){this.store=store;this.entries=new Map();this.preparing=new Map();this.wanted=new Map();this.startEpoch=0;this.error=null;this.context=null;this.destination=null;this.monitor=null;this.bus=null;this.epoch=0;this.running=false;this.base=0;this.clockStart=0;this.onError=onError;this.closed=false;this.planKey='';this.totalClips=0;this.lastSeekMs=0;}
 async resumeAudio(){if(this.closed)throw Error('媒体会话已关闭');if(!this.context){const Context=window.AudioContext||window.webkitAudioContext;if(!Context)throw Error('此浏览器不支持 Web Audio 混音');this.context=new Context();this.bus=this.context.createGain();this.monitor=this.context.createGain();this.destination=this.context.createMediaStreamDestination();this.bus.connect(this.monitor);this.monitor.connect(this.context.destination);this.bus.connect(this.destination);for(const entry of this.entries.values())this.connect(entry);}
 await this.context.resume();if(this.context.state!=='running')throw Error('音频尚未获准播放，请再次点击播放或导出');}
 connect(entry){if(entry.source||!this.context)return;entry.source=this.context.createMediaElementSource(entry.element);entry.gain=this.context.createGain();entry.gain.gain.value=0;entry.source.connect(entry.gain);entry.gain.connect(this.bus);entry.element.muted=false;}
 async prepare(project,time=0){if(this.closed)throw abort();const layers=mediaWorkingSet(project,time);this.planKey=mediaPlanKey(layers);this.totalClips=project.layers.filter(isMediaLayer).length;this.wanted=new Map(layers.map(l=>[l.id,l.type+'|'+l.assetId]));
 for(const[id,entry]of this.entries)if(this.wanted.get(id)!==entry.signature){disposeEntry(entry);this.entries.delete(id);}
 await Promise.all(layers.map(async layer=>{
  const signature=layer.type+'|'+layer.assetId,pendingKey=layer.id+'|'+signature;
  const existing=this.entries.get(layer.id);if(existing&&existing.signature===signature){await existing.ready;return;}
  if(this.preparing.has(pendingKey)){await this.preparing.get(pendingKey);return;}
  const pending=(async()=>{const asset=await this.store.get(layer.assetId);if(this.closed||this.wanted.get(layer.id)!==signature)throw abort();const element=document.createElement(layer.type==='video'?'video':'audio');element.preload='auto';element.playsInline=true;element.muted=true;
   const entry={element,assetId:layer.assetId,signature,source:null,gain:null,starting:false,initializing:true,loading:new AbortController()};const metadataReady=loaded(element,entry.loading.signal);this.entries.set(layer.id,entry);this.connect(entry);element.src=asset.url;
   entry.ready=(async()=>{await metadataReady;if(this.closed||this.wanted.get(layer.id)!==signature)throw abort();if(Number.isFinite(element.duration)&&Math.abs(element.duration-layer.mediaDuration)>.3)throw Error('素材时长与工程描述不一致，请重新导入素材');await seekElement(entry,sourceTimeAt(layer,time));if(this.closed||this.wanted.get(layer.id)!==signature)throw abort();entry.initializing=false;if(this.running)this.scheduleLayer(layer,entry,this.currentTime());})();
   try{await entry.ready;}
   catch(error){if(this.entries.get(layer.id)===entry)this.entries.delete(layer.id);disposeEntry(entry);throw error;}
  })();this.preparing.set(pendingKey,pending);try{await pending;}finally{this.preparing.delete(pendingKey);}
 }));}
 async seek(project,time){const epoch=++this.epoch,began=performance.now();this.pauseElements();await this.prepare(project,time);if(epoch!==this.epoch||this.closed)throw abort();await Promise.all(mediaWorkingSet(project,time).map(layer=>seekElement(this.entries.get(layer.id),sourceTimeAt(layer,time))));if(epoch!==this.epoch||this.closed)throw abort();this.lastSeekMs=performance.now()-began;return true;}
 stats(){return {decoders:this.entries.size,pending:this.preparing.size,total:this.totalClips,lastSeekMs:Math.round(this.lastSeekMs)};}
 pauseElements(){for(const entry of this.entries.values()){entry.element.pause();if(entry.gain){entry.gain.gain.cancelScheduledValues(0);entry.gain.gain.setValueAtTime(0,this.context.currentTime);}}}
 scheduleLayer(layer,entry,time){const gain=entry?.gain?.gain;if(!gain)return;gain.cancelScheduledValues(0);gain.setValueAtTime(0,this.context.currentTime);for(const point of audioEnvelope(layer,time)){const when=this.clockStart+point.time-this.base;if(point.kind==='ramp')gain.linearRampToValueAtTime(point.value,when);else gain.setValueAtTime(point.value,when);}}
 scheduleAudio(project,time){for(const layer of project.layers.filter(isMediaLayer))this.scheduleLayer(layer,this.entries.get(layer.id),time);}
 stop(){this.running=false;this.epoch++;this.startEpoch++;for(const entry of this.entries.values())if(!entry.initializing)entry.cancelSeek?.();this.pauseElements();}
 async start(project,time,{monitor=true}={}){const attempt=++this.startEpoch;await this.resumeAudio();if(attempt!==this.startEpoch)throw abort();await this.seek(project,time);if(attempt!==this.startEpoch)throw abort();this.monitor.gain.value=monitor?1:0;this.base=time;this.clockStart=this.context.currentTime;this.error=null;this.running=true;this.scheduleAudio(project,time);this.sync(project,time);return this.clockStart;}
 currentTime(){return this.base+(this.context?this.context.currentTime-this.clockStart:0);}
 sync(project,time){if(this.running&&mediaPlanKey(mediaWorkingSet(project,time))!==this.planKey){const attempt=this.startEpoch;this.prepare(project,time).catch(error=>{if(error.name!=='AbortError'&&this.running&&attempt===this.startEpoch){this.error=error;this.stop();this.onError(error);}});}for(const layer of project.layers.filter(isMediaLayer)){const entry=this.entries.get(layer.id);if(!entry)continue;const e=entry.element;if(entry.initializing||e.readyState<2)continue;const active=activeAt(layer,time),desired=sourceTimeAt(layer,time);
 if(!active||!this.running){if(!e.paused)e.pause();continue;}
 if(Math.abs(e.currentTime-desired)>.18&&!e.seeking){try{e.currentTime=Math.min(desired,Math.max(0,e.duration-.001));}catch(err){this.error=err;this.running=false;this.pauseElements();this.onError(err);}}
 if(e.paused&&!entry.starting){entry.starting=true;e.play().catch(err=>{if(err.name!=='AbortError'){this.error=Error('媒体播放失败，请再次点击播放：'+err.message);this.running=false;this.pauseElements();this.onError(this.error);}}).finally(()=>entry.starting=false);}
 }}
 frame(layer,time){const entry=this.entries.get(layer.id);if(!entry||entry.initializing||entry.element.readyState<2||entry.element.seeking)return null;const desired=sourceTimeAt(layer,time);if(Math.abs(entry.element.currentTime-desired)>.25)return null;return entry.element;}
 audioTracks(){return this.destination?.stream.getAudioTracks()??[];}
 async close(){this.stop();this.closed=true;for(const entry of this.entries.values())disposeEntry(entry);this.entries.clear();if(this.context&&this.context.state!=='closed')await this.context.close();}
}
