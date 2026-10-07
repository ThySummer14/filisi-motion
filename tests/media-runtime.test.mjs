import test from 'node:test';import assert from 'node:assert/strict';
import {MediaRuntime} from '../src/media.js';
class FakeMedia extends EventTarget {
 constructor(kind){super();this.kind=kind;this.readyState=0;this.duration=4;this._time=0;this.paused=true;this.seeking=false;this.playCalls=0;}
 set src(value){this._src=value;queueMicrotask(()=>{this.readyState=4;this.dispatchEvent(new Event('loadedmetadata'));});}
 get src(){return this._src;}
 set currentTime(value){this._time=value;this.seeking=true;setTimeout(()=>{this.readyState=4;this.seeking=false;this.dispatchEvent(new Event('seeked'));},2);}
 get currentTime(){return this._time;}
 pause(){this.paused=true;}
 play(){this.playCalls++;if(this.failPlay)return Promise.reject(Error('decoder stopped'));this.paused=false;return Promise.resolve();}
 removeAttribute(){this._src='';}
 load(){}
}
class FakeNode {constructor(){this.gain={value:0,events:[],cancelScheduledValues(t){this.events=this.events.filter(e=>e.time<t);},setValueAtTime(v,t){this.value=v;this.events.push({kind:'set',time:t,value:v});},linearRampToValueAtTime(v,t){this.events.push({kind:'ramp',time:t,value:v});}};}connect(){}disconnect(){}}
class FakeAudioContext {constructor(){this.currentTime=0;this.state='running';this.destination=new FakeNode();}createGain(){return new FakeNode();}createMediaStreamDestination(){return {...new FakeNode(),stream:{getAudioTracks:()=>[]}};}createMediaElementSource(){return new FakeNode();}async resume(){}async close(){this.state='closed';}}
const clip=(id='a',asset='source')=>({id,type:'video',assetId:asset,start:0,end:4,sourceIn:0,mediaDuration:4,volume:1,muted:false,fadeIn:0,fadeOut:0,visible:true,keys:{}});
const project=layers=>({layers});
function setup(store={get:async id=>({url:id})}){const made=[];globalThis.document={createElement:kind=>{const e=new FakeMedia(kind);made.push(e);return e;}};globalThis.window={AudioContext:FakeAudioContext};return{runtime:new MediaRuntime(store),made};}
test('concurrent prepare creates one decoder per clip',async()=>{const {runtime,made}=setup();const p=project([clip()]);await Promise.all([runtime.prepare(p),runtime.prepare(p),runtime.prepare(p)]);assert.equal(made.length,1);assert.equal(runtime.entries.size,1);await runtime.close();});
test('superseded seeks cannot overwrite the newest seek result',async()=>{const {runtime}=setup();const p=project([clip()]);await runtime.prepare(p);const a=runtime.seek(p,1).catch(e=>e.name),b=runtime.seek(p,2);assert.equal(await a,'AbortError');await b;assert.equal(runtime.frame(p.layers[0],2).currentTime,2);await runtime.close();});
test('project switch during pending asset load does not resurrect stale decoders',async()=>{let release;const old=new Promise(resolve=>release=resolve);const {runtime}=setup({get:id=>id==='old'?old:Promise.resolve({url:id})});const first=runtime.prepare(project([clip('same','old')])).catch(e=>e.name);await runtime.prepare(project([clip('same','new')]));release({url:'old'});assert.equal(await first,'AbortError');assert.equal(runtime.entries.get('same').assetId,'new');await runtime.close();});
test('clip identity includes kind and source, not just layer id',async()=>{const {runtime,made}=setup();await runtime.prepare(project([clip()]));await runtime.prepare(project([{...clip(),type:'audio'}]));assert.equal(made.length,2);assert.equal(runtime.entries.get('a').element.kind,'audio');await runtime.close();});
test('stop during asynchronous start prevents resumed playback',async()=>{const {runtime}=setup();let release;runtime.resumeAudio=()=>new Promise(resolve=>release=resolve);const start=runtime.start(project([clip()]),0).catch(e=>e.name);runtime.stop();release();assert.equal(await start,'AbortError');assert.equal(runtime.running,false);await runtime.close();});
test('decoder play failure stops runtime and surfaces one persistent error',async()=>{const {runtime}=setup();const p=project([clip()]);await runtime.prepare(p);runtime.entries.get('a').element.failPlay=true;await runtime.start(p,0);await Promise.resolve();assert.equal(runtime.running,false);assert.match(runtime.error.message,/播放失败/);const calls=runtime.entries.get('a').element.playCalls;runtime.sync(p,1);assert.equal(runtime.entries.get('a').element.playCalls,calls);await runtime.close();});

test('audio cut is pre-scheduled on audio clock before any later video frame',async()=>{
 const {runtime}=setup();const l={...clip(),end:2};const p=project([l]);await runtime.start(p,0);
 const gain=runtime.entries.get('a').gain.gain;
 assert.deepEqual(gain.events.at(-1),{kind:'set',time:2,value:0});
 const before=JSON.stringify(gain.events);runtime.sync(p,.5);assert.equal(JSON.stringify(gain.events),before);
 runtime.stop();assert.deepEqual(gain.events,[{kind:'set',time:0,value:0}]);await runtime.close();
});
