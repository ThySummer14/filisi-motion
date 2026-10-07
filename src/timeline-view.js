// Frame-aligned ruler and viewport helpers for long compositions.
export function timelineTicks(duration,fps,width){
 const total=Math.round(duration*fps),target=duration*fps*76/Math.max(1,width);
 const steps=[...new Set([1,2,3,5,10,15,...[1,2,5,10,15,30,60,120,300].map(n=>n*fps)])].sort((a,b)=>a-b);
 const step=steps.find(n=>n>=target)??steps.at(-1),ticks=[];
 for(let frame=0;frame<=total;frame+=step){const seconds=frame/fps;ticks.push({frame,time:seconds,left:seconds/duration*100,label:frame%fps===0?`${seconds}s`:`${Math.floor(seconds)}s ${frame%fps}f`});}
 return ticks;
}
export function timelineScrollForTime({time,duration,trackWidth,labelWidth,viewportWidth,currentScroll,center=false}){
 const x=labelWidth+time/duration*trackWidth,max=Math.max(0,labelWidth+trackWidth-viewportWidth);
 if(!center&&x>=currentScroll+labelWidth+12&&x<=currentScroll+viewportWidth-20)return currentScroll;
 const visible=Math.max(1,viewportWidth-labelWidth),next=center?x-labelWidth-visible/2:x<currentScroll+labelWidth+12?x-labelWidth-20:x-viewportWidth+40;
 return Math.max(0,Math.min(max,next));
}
