// A timeline working set: visible clips now, plus the next start group.
// A serial cut sequence shares no simultaneous pictures, so it needs only the
// current and next decoder instead of one decoder for every cut in the movie.
import {isMediaLayer,activeAt} from './media-core.js?v=0.4.0';
export function mediaWorkingSet(project,time){
 if(!Number.isFinite(time))throw new TypeError('Media time must be finite');
 const layers=project.layers.filter(l=>isMediaLayer(l)&&l.visible!==false);
 const current=layers.filter(l=>activeAt(l,time));
 const upcoming=layers.filter(l=>l.start>time);
 const next=upcoming.length?Math.min(...upcoming.map(l=>l.start)):Infinity;
 return [...current,...upcoming.filter(l=>Math.abs(l.start-next)<1e-7)];
}
export const mediaPlanKey=layers=>layers.map(l=>`${l.id}|${l.type}|${l.assetId}`).sort().join('\n');
