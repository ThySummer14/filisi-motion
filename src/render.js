import {gainAt} from './media-core.js?v=0.3.1';
import {evaluated} from './core.js?v=0.3.1';
export const images = new Map();
export async function loadImages(project) {
  await Promise.all(project.layers.filter(l=>l.type==='image').map(async l=>{
    if(images.has(l.src))return;const image=new Image();image.src=l.src;await image.decode();images.set(l.src,image);
  }));
}
export function drawProject(ctx,project,time,{width=project.width,height=project.height,selected=null,media=null}={}){
  ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,width,height);ctx.fillStyle=project.background;ctx.fillRect(0,0,width,height);ctx.scale(width/project.width,height/project.height);
  for(const source of project.layers){if(!source.visible||source.type==='audio'||time<source.start||time>=source.end)continue;const l=evaluated(source,time);
    ctx.save();ctx.translate(l.x,l.y);ctx.rotate(l.rotation*Math.PI/180);ctx.scale(l.scale,l.scale);ctx.globalAlpha=l.opacity*(l.type==='video'?gainAt({...l,volume:1,muted:false},time):1);ctx.globalCompositeOperation=l.blend;ctx.filter=l.blur?`blur(${l.blur}px)`:'none';ctx.fillStyle=l.fill;
    if(l.type==='rect'){ctx.beginPath();ctx.roundRect(-l.width/2,-l.height/2,l.width,l.height,Math.min(l.radius,l.width/2,l.height/2));ctx.fill();}
    if(l.type==='ellipse'){ctx.beginPath();ctx.ellipse(0,0,l.width/2,l.height/2,0,0,Math.PI*2);ctx.fill();}
    if(l.type==='text'){ctx.font=`${l.fontWeight} ${l.fontSize}px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;ctx.textAlign=l.align;ctx.textBaseline='middle';const lines=l.text.split('\n');lines.forEach((line,i)=>ctx.fillText(line,l.align==='left'?-l.width/2:l.align==='right'?l.width/2:0,(i-(lines.length-1)/2)*l.fontSize*1.2));}
    if(l.type==='video'){const frame=media?.frame(l,time);if(frame)ctx.drawImage(frame,-l.width/2,-l.height/2,l.width,l.height);}
    if(l.type==='image'){const img=images.get(l.src);if(img)ctx.drawImage(img,-l.width/2,-l.height/2,l.width,l.height);}
    ctx.restore();
    if(selected===l.id){ctx.save();ctx.translate(l.x,l.y);ctx.rotate(l.rotation*Math.PI/180);ctx.scale(l.scale,l.scale);ctx.strokeStyle='#a8eb73';ctx.lineWidth=2*project.width/width/l.scale;ctx.strokeRect(-l.width/2-5,-l.height/2-5,l.width+10,l.height+10);for(const [x,y]of[[-1,-1],[-1,1],[1,-1],[1,1]]){ctx.fillStyle='#a8eb73';const s=7*project.width/width/l.scale;ctx.fillRect(x*(l.width/2+5)-s/2,y*(l.height/2+5)-s/2,s,s);}ctx.restore();}
  }ctx.restore();
}
export function hitTest(project,time,x,y){for(const source of [...project.layers].reverse()){if(!source.visible||source.type==='audio'||source.locked||time<source.start||time>=source.end)continue;const l=evaluated(source,time);const r=-l.rotation*Math.PI/180,dx=x-l.x,dy=y-l.y;const px=(dx*Math.cos(r)-dy*Math.sin(r))/l.scale,py=(dx*Math.sin(r)+dy*Math.cos(r))/l.scale;if(Math.abs(px)<=l.width/2+6&&Math.abs(py)<=l.height/2+6)return source.id;}return null;}

