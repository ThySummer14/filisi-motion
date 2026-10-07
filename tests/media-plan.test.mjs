import test from 'node:test';import assert from 'node:assert/strict';
import {mediaWorkingSet} from '../src/media-plan.js';
const video=(i,start,end)=>({id:'v'+i,type:'video',assetId:'one',start,end,sourceIn:start,mediaDuration:180,volume:1,muted:true,fadeIn:0,fadeOut:0,visible:true,keys:{}});
test('long serial edit keeps current/next pictures plus continuous soundtrack',()=>{
 const p={layers:[{...video('audio',0,160),type:'audio'},...Array.from({length:16},(_,i)=>video(i,i*10,(i+1)*10))]};
 for(const t of [0,9.99,10,85,150,159.99]){const set=mediaWorkingSet(p,t);assert.ok(set.length<=3);assert.ok(set.some(l=>l.type==='audio'));assert.equal(set.filter(l=>l.type==='video'&&l.start<=t&&l.end>t).length,1);}
 assert.deepEqual(mediaWorkingSet(p,160),[]);
});
test('preload includes all simultaneous future starts without dropping active overlaps',()=>{
 const p={layers:[video(0,0,12),video(1,3,10),video(2,5,8),video(3,5,9),video(4,9,12)]};
 assert.deepEqual(mediaWorkingSet(p,4).map(l=>l.id),['v0','v1','v2','v3']);
 assert.deepEqual(mediaWorkingSet(p,8).map(l=>l.id),['v0','v1','v3','v4']);
});
test('gaps, hidden media and non-media do not allocate unnecessary decoders',()=>{
 const p={layers:[video(0,2,4),{...video(1,1,3),visible:false},{type:'text',start:0,end:9},video(2,7,9)]};
 assert.deepEqual(mediaWorkingSet(p,0).map(l=>l.id),['v0']);assert.deepEqual(mediaWorkingSet(p,4).map(l=>l.id),['v2']);assert.throws(()=>mediaWorkingSet(p,NaN));
});
