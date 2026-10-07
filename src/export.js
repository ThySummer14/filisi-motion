import {drawProject} from './render.js?v=0.3.0';
import {GifEncoder} from './gif.js';
import {hasMedia} from './media.js?v=0.3.0';
export const recorderType=()=>typeof MediaRecorder==='undefined'?null:['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm'].find(t=>MediaRecorder.isTypeSupported(t));
export async function exportStill(project,time,media){if(media)await media.seek(project,time);const off=document.createElement('canvas');off.width=project.width;off.height=project.height;drawProject(off.getContext('2d'),project,time,{media});return new Promise((resolve,reject)=>off.toBlob(blob=>blob?resolve(blob):reject(Error('PNG 导出失败')),'image/png'));}
export async function exportGifFrames(project,{width,fps,media,cancelled,progress}){const height=Math.round(width*project.height/project.width),count=Math.ceil(project.duration*fps);if(count>600||count*width*height>80000000)throw Error('GIF 超过资源上限，请缩短合成、降低宽度或帧率');const off=document.createElement('canvas');off.width=width;off.height=height;const ctx=off.getContext('2d',{willReadFrequently:true}),encoder=new GifEncoder(width,height,fps);
 for(let i=0;i<count;i++){if(cancelled())throw Error('已取消导出');if(media)await media.seek(project,i/fps);drawProject(ctx,project,i/fps,{width,height,media});encoder.addFrame(ctx.getImageData(0,0,width,height).data);progress((i+1)/count,`正在渲染 ${i+1} / ${count} 帧`);if(i%2===0)await new Promise(r=>setTimeout(r,0));}return encoder.finish();}
export async function exportRealtime(project,{media,cancelled,progress}){
 const type=recorderType();if(!type)throw Error('此浏览器无法录制 WebM');if(document.hidden)throw Error('请保持此页面在前台后重试');
 const off=document.createElement('canvas');off.width=project.width;off.height=project.height;const ctx=off.getContext('2d');
 if(media){await media.prepare(project);await media.seek(project,0);}
 drawProject(ctx,project,0,{media});const canvasStream=off.captureStream(project.fps);const tracks=[...canvasStream.getVideoTracks(),...(hasMedia(project)&&media?media.audioTracks():[])];const stream=new MediaStream(tracks);let recorder;
 try{recorder=new MediaRecorder(stream,{mimeType:type,videoBitsPerSecond:Math.min(16000000,project.width*project.height*project.fps*.18),audioBitsPerSecond:192000});}catch(err){tracks.forEach(t=>t.stop());throw err;}
 return new Promise((resolve,reject)=>{
  const chunks=[];let error=null,raf=0,finished=false,started=0;
  const stopRecording=reason=>{if(finished)return;if(reason)error=Error(reason);media?.stop();if(recorder.state!=='inactive')recorder.stop();else if(!started){cleanup();reject(error??Error('录制未开始'));}};
  const visibility=()=>{if(document.hidden)stopRecording('页面移到后台，录制已停止。请保持前台后重试。');};
  const watchdog=setInterval(()=>{if(cancelled())stopRecording('已取消导出');},100);
  const cleanup=()=>{finished=true;cancelAnimationFrame(raf);clearInterval(watchdog);document.removeEventListener('visibilitychange',visibility);tracks.forEach(t=>t.stop());media?.stop();};
  recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
  recorder.onerror=e=>{error=e.error??Error('视频录制失败');if(recorder.state!=='inactive')recorder.stop();else{cleanup();reject(error);}};
  recorder.onstop=()=>{cleanup();if(error)reject(error);else resolve(new Blob(chunks,{type:'video/webm'}));};
  document.addEventListener('visibilitychange',visibility);
  (async()=>{try{if(cancelled())throw Error('已取消导出');if(media)await media.start(project,0,{monitor:false});if(finished)return;started=performance.now();recorder.start(100);
   function frame(now){if(finished||recorder.state==='inactive')return;const elapsed=media?media.currentTime():(now-started)/1000;if(cancelled()){stopRecording('已取消导出');return;}if(media?.error){stopRecording(media.error.message);return;}if(elapsed>=project.duration){progress(1,'正在完成封装…');stopRecording();return;}const t=elapsed;media?.sync(project,t);drawProject(ctx,project,t,{media});progress(Math.min(1,elapsed/project.duration),`正在实时录制 ${Math.min(elapsed,project.duration).toFixed(1)} / ${project.duration} 秒`);if(elapsed>=project.duration)stopRecording();else raf=requestAnimationFrame(frame);}raf=requestAnimationFrame(frame);
  }catch(err){cleanup();reject(err);}})();
 });
}
