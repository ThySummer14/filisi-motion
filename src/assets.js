// Local-only media assets. Project history contains metadata, never duplicate video bytes.
export const MAX_ASSET_BYTES=64*1024*1024;
export const MAX_TOTAL_BYTES=128*1024*1024;
const TYPES=new Set(['video/mp4','video/webm','video/quicktime','audio/mpeg','audio/mp4','audio/wav','audio/x-wav','audio/ogg','audio/webm','audio/flac']);
const extensionTypes={mp4:'video/mp4',webm:'video/webm',mov:'video/quicktime',mp3:'audio/mpeg',m4a:'audio/mp4',wav:'audio/wav',ogg:'audio/ogg',flac:'audio/flac'};
export function mimeFor(file){const mime=file.type||extensionTypes[file.name?.split('.').at(-1)?.toLowerCase()];if(!TYPES.has(mime))throw Error('请选择浏览器支持的 MP4 / WebM 视频，或 MP3 / WAV / M4A / OGG 音频');return mime;}
export async function hashBlob(blob){const data=await blob.arrayBuffer();const hash=await crypto.subtle.digest('SHA-256',data);return 'asset-'+Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');}
function waitMedia(element,events,ready,timeout=12000){return new Promise((resolve,reject)=>{if(ready()){resolve();return;}let timer;
 const cleanup=()=>{clearTimeout(timer);for(const event of events)element.removeEventListener(event,check);element.removeEventListener('error',fail);};
 const check=()=>{if(ready()){cleanup();resolve();}};const fail=()=>{cleanup();reject(Error('浏览器无法解码此素材，请尝试 H.264/AAC MP4 或 WAV'));};
 for(const event of events)element.addEventListener(event,check);element.addEventListener('error',fail,{once:true});timer=setTimeout(()=>{cleanup();reject(Error('读取媒体超时，请换用较短的标准编码素材'));},timeout);
 });}
export async function probeMedia(blob,mime){const element=document.createElement(mime.startsWith('video/')?'video':'audio'),url=URL.createObjectURL(blob);element.preload='auto';element.muted=true;element.src=url;
 try{await waitMedia(element,['loadedmetadata','durationchange'],()=>element.readyState>=1);
 if(!Number.isFinite(element.duration)){element.currentTime=1e10;await waitMedia(element,['durationchange','timeupdate'],()=>Number.isFinite(element.duration));element.currentTime=0;}
 if(!(element.duration>0&&element.duration<=7200))throw Error('素材时长须在 0–7200 秒以内');
 if(mime.startsWith('video/')&&(!element.videoWidth||element.videoWidth>7680||element.videoHeight>4320))throw Error('视频尺寸无效或超过 8K 解码上限');
 return {duration:element.duration,width:element.videoWidth||0,height:element.videoHeight||0,type:mime.startsWith('video/')?'video':'audio'};
 }finally{element.pause();element.removeAttribute('src');element.load();URL.revokeObjectURL(url);}}
const blobDataURL=blob=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error('读取素材字节失败'));reader.readAsDataURL(blob);});
export class AssetStore {
 constructor(){this.cache=new Map();this.database=null;this.opening=null;}
 async db(){if(this.database)return this.database;if(this.opening)return this.opening;this.opening=new Promise((resolve,reject)=>{const request=indexedDB.open('filisi-motion-media-v1',1);request.onupgradeneeded=()=>request.result.createObjectStore('assets',{keyPath:'id'});request.onsuccess=()=>{this.database=request.result;resolve(request.result);};request.onerror=()=>reject(request.error);});return this.opening;}
 async remember(meta,blob){let stored=false;try{const db=await this.db();await new Promise((resolve,reject)=>{const tx=db.transaction('assets','readwrite');tx.objectStore('assets').put({id:meta.id,meta,blob});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});stored=true;}catch{/* Still usable in this session; UI must advise portable save. */}
 const old=this.cache.get(meta.id);if(old)URL.revokeObjectURL(old.url);this.cache.set(meta.id,{meta,blob,url:URL.createObjectURL(blob),stored});return stored;}
 async importFile(file){if(file.size<=0||file.size>MAX_ASSET_BYTES)throw Error('单个媒体文件须在 64 MB 以内');const mime=mimeFor(file),blob=file.type===mime?file:new Blob([file],{type:mime});const [id,details]=await Promise.all([hashBlob(blob),probeMedia(blob,mime)]);const meta={id,name:String(file.name||'媒体素材').slice(0,180),mime,size:blob.size,...details};const stored=await this.remember(meta,blob);return {meta,stored};}
 async get(id){if(this.cache.has(id))return this.cache.get(id);let record;try{const db=await this.db();record=await new Promise((resolve,reject)=>{const r=db.transaction('assets').objectStore('assets').get(id);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}catch{throw Error('浏览器素材缓存不可用，请重新打开包含素材的工程');}
 if(!record?.blob)throw Error('工程的本地素材已丢失，请打开已下载的完整工程文件');const entry={meta:record.meta,blob:record.blob,url:URL.createObjectURL(record.blob),stored:true};this.cache.set(id,entry);return entry;}
 persisted(project){return (project.assets??[]).every(a=>this.cache.get(a.id)?.stored===true);}
 async ingest(project){for(const asset of project.assets??[]){if(asset.data){const comma=asset.data.indexOf(',');const binary=atob(asset.data.slice(comma+1));if(binary.length!==asset.size)throw Error('素材大小校验失败');const bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);const blob=new Blob([bytes],{type:asset.mime});if(await hashBlob(blob)!==asset.id)throw Error('素材哈希校验失败，文件可能已损坏');const {data,...meta}=asset;await this.remember(meta,blob);delete asset.data;}else await this.get(asset.id);}return project;}
 async portable(project){const out=JSON.parse(JSON.stringify(project));for(const asset of out.assets){const entry=await this.get(asset.id);asset.data=await blobDataURL(entry.blob);}return out;}
}
