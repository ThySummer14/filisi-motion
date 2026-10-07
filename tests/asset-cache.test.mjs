import test from 'node:test';import assert from 'node:assert/strict';import {resolveObjectURL} from 'node:buffer';
import {AssetStore} from '../src/assets.js';
test('project switch releases only persisted unused memory, preserving unsaved sources',()=>{
 const store=new AssetStore();const entries=['active','saved-old','unsaved-old'].map((id,i)=>{const blob=new Blob([new Uint8Array(10+i)]),entry={blob,url:URL.createObjectURL(blob),stored:i!==2};store.cache.set(id,entry);return entry;});
 assert.equal(store.retainedAssets().reduce((n,a)=>n+a.size,0),33);
 store.releaseUnused({assets:[{id:'active'}]});assert.deepEqual(store.retainedAssets(),[{id:'active',size:10},{id:'unsaved-old',size:12}]);
 assert.equal(resolveObjectURL(entries[1].url),undefined);assert.ok(resolveObjectURL(entries[0].url));assert.ok(resolveObjectURL(entries[2].url));
 for(const entry of entries)URL.revokeObjectURL(entry.url);
});

test('reimporting identical content keeps live decoder URL and still writes persistence metadata',async()=>{
 const store=new AssetStore(),writes=[];
 store.db=async()=>({transaction(){const tx={objectStore:()=>({put(value){writes.push(value);queueMicrotask(()=>tx.oncomplete());}})};return tx;}});
 const blob=new Blob(['same immutable media']);const meta={id:'content-hash',name:'first.mp4'};
 assert.equal(await store.remember(meta,blob),true);const first=store.cache.get(meta.id);
 assert.equal(await store.remember({...meta,name:'portable-copy.mp4'},new Blob(['same immutable media'])),true);const second=store.cache.get(meta.id);
 assert.equal(first.url,second.url);assert.equal(first.blob,second.blob);assert.ok(resolveObjectURL(first.url));
 assert.equal(writes.length,2);assert.equal(writes[1].meta.name,'portable-copy.mp4');assert.equal(writes[1].blob,blob);
 store.releaseUnused({assets:[]});assert.equal(resolveObjectURL(first.url),undefined);
});
