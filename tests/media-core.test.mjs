import test from 'node:test';
import assert from 'node:assert/strict';
import {makeLayer,setKey,valueAt} from '../src/core.js';
import {isMediaLayer,validateMediaLayer,activeAt,sourceTimeAt,gainAt,trimClip,moveClip,splitClip,detachAudio,audioEnvelope} from '../src/media-core.js';
const clip = (props={}) => ({...makeLayer('video',10),id:'a',assetId:'synthetic-video',start:2,end:8,sourceIn:1,mediaDuration:12,volume:1,muted:false,fadeIn:0,fadeOut:0,...props});
const near = (a,b) => assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);
test('media types, source seeking and exclusive active endpoint',()=>{
  const l=clip();assert.ok(isMediaLayer(l));assert.ok(isMediaLayer(clip({type:'audio'})));assert.ok(!isMediaLayer(null));assert.ok(!isMediaLayer({type:'image'}));
  for(const [t,s] of [[-9,1],[2,1],[3,2],[8,7],[99,7]])near(sourceTimeAt(l,t),s);
  assert.equal(activeAt(l,2),true);assert.equal(activeAt(l,8),false);assert.equal(activeAt(l,1.99),false);
  assert.equal(activeAt(clip({visible:false}),3),false);assert.equal(activeAt(clip({muted:true}),3),true);
  assert.equal(activeAt({},3),false);assert.equal(activeAt(l,NaN),false);
});
test('gain accounts for fades, overlap, mute, volume and inactive clips',()=>{
  const l=clip({volume:2,fadeIn:4,fadeOut:4});
  near(gainAt(l,2),0);near(gainAt(l,3),.5);near(gainAt(l,5),1.125);near(gainAt(l,7),.5);near(gainAt(l,8),0);
  near(gainAt(clip({volume:0}),3),0);near(gainAt({...l,muted:true},3),0);near(gainAt({...l,visible:false},3),0);
  near(gainAt(clip(),2),1);near(gainAt(clip(),-1),0);near(gainAt({},3),0);
});
test('trim shifts source in, preserves keys and fade envelope, permits bounded extension',()=>{
  const l=clip({fadeIn:3,fadeOut:2});setKey(l,'x',0,0,'linear');setKey(l,'x',10,100);
  const before=JSON.stringify(l),r=trimClip(l,3,7);assert.deepEqual([r.start,r.end,r.sourceIn],[3,7,2]);assert.deepEqual(r.keys,l.keys);
  for(let t=3;t<7;t+=.25){near(sourceTimeAt(r,t),sourceTimeAt(l,t));near(gainAt(r,t),gainAt(l,t));}
  assert.deepEqual([trimClip(l,-10,99).start,trimClip(l,-10,99).end,trimClip(l,-10,99).sourceIn],[1,13,0]);
  const z=trimClip(clip({sourceIn:5}),-10,99);assert.equal(z.start,0);assert.equal(z.sourceIn,3);
  r.keys.x[0].value=999;assert.equal(JSON.stringify(l),before);
  assert.throws(()=>trimClip(l,9,9));assert.throws(()=>trimClip(l,20,30));assert.throws(()=>trimClip(l,-20,-10));
});
test('move clamps entire clip and shifts every key without collapse, preserving Bezier',()=>{
  const l=clip();setKey(l,'x',0,0,'bezier',[.2,.9,.7,.1]);setKey(l,'x',1,30,'hold');setKey(l,'x',10,100);
  const before=JSON.stringify(l),r=moveClip(l,-20,12);assert.deepEqual([r.start,r.end,r.sourceIn],[0,6,1]);assert.deepEqual(r.keys.x.map(k=>k.time),[-2,-1,8]);
  for(let t=0;t<6;t+=.1)near(valueAt(r,'x',t),valueAt(l,'x',t+2));
  const s=moveClip(l,100,12);assert.deepEqual([s.start,s.end],[6,12]);assert.equal(s.keys.x[2].time,14);
  assert.equal(JSON.stringify(l),before);assert.throws(()=>moveClip(l,1,5));
});
test('split preserves source, custom Bezier and hold animation and fade gain on both halves',()=>{
  const l=clip({fadeIn:5,fadeOut:5});setKey(l,'x',0,0,'bezier',[.13,1,.91,0]);setKey(l,'x',9,100);setKey(l,'opacity',1,.1,'hold');setKey(l,'opacity',7,.9);
  const before=JSON.stringify(l),[a,b]=splitClip(l,4,'b');assert.deepEqual([a.start,a.end,a.sourceIn,b.start,b.end,b.sourceIn],[2,4,1,4,8,3]);
  for(let t=2;t<8;t+=.013){const r=t<4?a:b;near(sourceTimeAt(r,t),sourceTimeAt(l,t));near(gainAt(r,t),gainAt(l,t));near(valueAt(r,'x',t),valueAt(l,'x',t));near(valueAt(r,'opacity',t),valueAt(l,'opacity',t));}
  near(valueAt(a,'x',4),valueAt(b,'x',4));assert.equal(activeAt(a,4),false);assert.equal(activeAt(b,4),true);
  assert.equal(JSON.stringify(l),before);a.keys.x[0].curve[0]=.99;assert.notEqual(a.keys.x[0].curve[0],b.keys.x[0].curve[0]);
  a.fadeOrigin.sourceIn=0;assert.equal(b.fadeOrigin.sourceIn,1);
});
test('repeated split, trim, move and JSON round trip retain fade and source alignment',()=>{
  const l=clip({fadeIn:5,fadeOut:3});const [,b]=splitClip(l,4,'b');const [c]=splitClip(b,6,'c');const r=moveClip(trimClip(c,4.5,5.5),0,12);
  const loaded=JSON.parse(JSON.stringify(r));validateMediaLayer(loaded);
  for(let t=0;t<1;t+=.1){near(gainAt(loaded,t),gainAt(l,t+4.5));near(sourceTimeAt(loaded,t),sourceTimeAt(l,t+4.5));}
});
test('overlapping independent clips sum independently; split does not double audible boundary',()=>{
  const a=clip({type:'audio'}),b=clip({id:'b',start:4,end:10});near(gainAt(a,5)+gainAt(b,5),2);
  const [left,right]=splitClip(a,5,'c');near(gainAt(left,5)+gainAt(right,5),gainAt(a,5));
});
test('invalid numbers, field types, source bounds, key ordering and split ids are rejected',()=>{
  const bad=[{assetId:''},{volume:3},{volume:-1},{muted:'false'},{fadeIn:-1},{fadeIn:301},{fadeOut:301},{mediaDuration:7201},{fadeOut:Infinity},{start:-1},{end:2},{sourceIn:-1},{sourceIn:10},{mediaDuration:0},{mediaDuration:NaN},{fadeOrigin:{sourceIn:0,duration:99}},{keys:{x:[{time:1,value:1},{time:1,value:2}]}},{keys:{x:[{time:NaN,value:1}]}}];
  for(const p of bad)assert.throws(()=>validateMediaLayer(clip(p)),JSON.stringify(p));
  const l=clip();for(const t of [NaN,Infinity,'3',null]){assert.throws(()=>sourceTimeAt(l,t));assert.throws(()=>trimClip(l,t,7));assert.throws(()=>moveClip(l,t,12));assert.throws(()=>splitClip(l,t,'b'));}
  for(const t of [2,8,1,9])assert.throws(()=>splitClip(l,t,'b'));
  for(const id of ['',null,'a'])assert.throws(()=>splitClip(l,4,id));assert.throws(()=>sourceTimeAt({},1));
});

test('detach audio preserves source/fades but not spatial keys, and mutes only video',()=>{
 const l=trimClip(clip({fadeIn:3,fadeOut:2,volume:.6}),3,7);setKey(l,'scale',2,1);setKey(l,'scale',8,1.2);
 const before=JSON.stringify(l),{video,audio}=detachAudio(l,'audio-copy');
 assert.equal(JSON.stringify(l),before);assert.equal(video.muted,true);assert.equal(audio.muted,false);
 assert.equal(audio.type,'audio');assert.deepEqual(audio.keys,{});assert.deepEqual(video.keys,l.keys);
 for(let t=3;t<7;t+=.125){near(sourceTimeAt(audio,t),sourceTimeAt(l,t));near(gainAt(audio,t),gainAt(l,t));near(gainAt(video,t),0);}
 audio.fadeOrigin.duration=99;assert.notEqual(audio.fadeOrigin.duration,video.fadeOrigin.duration);
 assert.throws(()=>detachAudio(l,l.id));assert.throws(()=>detachAudio({...l,type:'audio'},'another'));
});

test('audio automation clips precisely and preserves split/trim fade envelopes',()=>{
 const l=clip({fadeIn:4,fadeOut:4});const points=audioEnvelope(l,3);
 assert.deepEqual(points[0],{time:3,value:gainAt(l,3),kind:'set'});assert.deepEqual(points.at(-1),{time:8,value:0,kind:'set'});
 for(const p of points.slice(0,-1))near(p.value,gainAt(l,p.time));
 assert.ok(points.length<=52);assert.deepEqual(audioEnvelope({...l,muted:true}),[]);assert.deepEqual(audioEnvelope(l,8),[]);
 const short=trimClip(l,4,6);assert.equal(audioEnvelope(short)[0].value,gainAt(l,4));assert.equal(audioEnvelope(short).at(-1).time,6);
});
