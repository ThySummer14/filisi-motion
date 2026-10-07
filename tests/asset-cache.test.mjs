import test from 'node:test';import assert from 'node:assert/strict';import {resolveObjectURL} from 'node:buffer';
import {AssetStore} from '../src/assets.js';
test('project switch releases only persisted unused memory, preserving unsaved sources',()=>{
 const store=new AssetStore();const entries=['active','saved-old','unsaved-old'].map((id,i)=>{const blob=new Blob([new Uint8Array(10+i)]),entry={blob,url:URL.createObjectURL(blob),stored:i!==2};store.cache.set(id,entry);return entry;});
 assert.equal(store.retainedAssets().reduce((n,a)=>n+a.size,0),33);
 store.releaseUnused({assets:[{id:'active'}]});assert.deepEqual(store.retainedAssets(),[{id:'active',size:10},{id:'unsaved-old',size:12}]);
 assert.equal(resolveObjectURL(entries[1].url),undefined);assert.ok(resolveObjectURL(entries[0].url));assert.ok(resolveObjectURL(entries[2].url));
 for(const entry of entries)URL.revokeObjectURL(entry.url);
});
