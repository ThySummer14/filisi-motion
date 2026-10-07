import test from 'node:test';import assert from 'node:assert/strict';
import {timelineTicks,timelineScrollForTime} from '../src/timeline-view.js';
test('long-film ruler gains useful intermediate ticks when zoomed',()=>{
 const fit=timelineTicks(170,24,480),zoom=timelineTicks(170,24,12000);assert.ok(zoom.length>fit.length*10);
 for(const tick of zoom){assert.ok(Number.isInteger(tick.frame));assert.equal(tick.time,tick.frame/24);assert.ok(tick.left<=100);}
});
test('short ruler labels align to actual frames rather than arbitrary decimals',()=>{
 const ticks=timelineTicks(1,24,600);assert.ok(ticks.some(t=>t.label.includes('f')));assert.ok(ticks.every(t=>t.frame%ticks[1].frame===0));
});
test('playhead remains visible with sticky layer names, and center zoom preserves focus',()=>{
 const base={duration:170,trackWidth:12000,labelWidth:190,viewportWidth:670,currentScroll:0};
 const far=timelineScrollForTime({...base,time:150});assert.ok(far>10000);
 assert.equal(timelineScrollForTime({...base,time:150,currentScroll:far}),far);
 assert.equal(timelineScrollForTime({...base,time:0,currentScroll:far}),0);
 const center=timelineScrollForTime({...base,time:85,center:true});assert.equal(center,6000-240);
 assert.ok(timelineScrollForTime({...base,time:170,center:true})<=12000+190-670);
});
