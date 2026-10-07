// Original, DOM-isolated value graph. Mutations go through the host's history hooks.
import {PROPERTIES, valueAt, clamp} from './core.js?v=0.3.0';
import {DEFAULT_CURVE, graphBounds, moveGraphKey} from './curve.js?v=0.3.0';
const names = {x:'位置 X',y:'位置 Y',scale:'缩放',rotation:'旋转',opacity:'不透明度',blur:'模糊'};
const limits = {x:[-20000,20000],y:[-20000,20000],scale:[.01,20],rotation:[-36000,36000],opacity:[0,1],blur:[0,100]};
const modes = {linear:'线性',easeIn:'缓入',easeOut:'缓出',easeInOut:'缓入缓出',hold:'保持',bezier:'自定义贝塞尔'};
const escape = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const W=1000,H=166,LEFT=60,RIGHT=20,TOP=14,BOTTOM=24;
export function createGraphEditor(container, host) {
  let property='x', frozenBounds=null, dragging=false;
  const state = () => host.getState();
  const selectedIndex = (keys, selection) => keys.findIndex(k => selection?.property===property && k.time===selection.time);
  function startDrag(event, update, finish) {
    const origin=[event.clientX,event.clientY];let recorded=false;
    dragging=true;event.preventDefault();host.stop();
    function move(e) {
      if(!recorded && Math.hypot(e.clientX-origin[0],e.clientY-origin[1])<3)return;
      if(!recorded){host.checkpoint();recorded=true;}
      update(e);host.preview();render();
    }
    function end(e) {
      window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',end);window.removeEventListener('pointercancel',end);
      dragging=false;frozenBounds=null;finish?.();if(recorded)host.commit();else render();
    }
    window.addEventListener('pointermove',move);window.addEventListener('pointerup',end,{once:true});window.addEventListener('pointercancel',end,{once:true});
  }
  function edit(fn) {const s=state();if(!s.layer||s.layer.locked)return;host.stop();host.checkpoint();fn(s);host.commit();}
  function render() {
    if(container.hidden)return;
    const s=state(),l=s.layer;
    if(!l){container.innerHTML='<div class="graph-empty">先在时间线或画布选中图层，再查看它的动画曲线。</div>';return;}
    if(!dragging && s.selection?.property)property=s.selection.property;
    const animated=PROPERTIES.filter(p=>l.keys[p]?.length);
    if(!animated.includes(property))property=animated[0]??'x';
    const keys=l.keys[property]??[],index=selectedIndex(keys,s.selection),key=keys[index],next=keys[index+1];
    const bounds=frozenBounds??graphBounds(keys,l[property]);
    const px=t=>LEFT+t/s.project.duration*(W-LEFT-RIGHT);
    const py=v=>TOP+(bounds.max-v)/(bounds.max-bounds.min)*(H-TOP-BOTTOM);
    const tAt=x=>(x-LEFT)/(W-LEFT-RIGHT)*s.project.duration;
    const vAt=y=>bounds.max-(y-TOP)/(H-TOP-BOTTOM)*(bounds.max-bounds.min);
    const points=Array.from({length:321},(_,i)=>{const t=i/320*s.project.duration;return`${px(t).toFixed(3)},${py(valueAt(l,property,t)).toFixed(3)}`;}).join(' ');
    const grid=Array.from({length:5},(_,i)=>{const y=TOP+i/4*(H-TOP-BOTTOM),v=bounds.max-i/4*(bounds.max-bounds.min);return`<line x1="${LEFT}" x2="${W-RIGHT}" y1="${y}" y2="${y}" class="graph-grid"/><text x="${LEFT-9}" y="${y+4}" text-anchor="end">${Number(v.toFixed(2))}</text>`;}).join('');
    const ticks=Array.from({length:7},(_,i)=>{const t=s.project.duration*i/6,x=px(t);return`<line x1="${x}" x2="${x}" y1="${TOP}" y2="${H-BOTTOM}" class="graph-grid"/><text x="${x}" y="${H-6}" text-anchor="middle">${Number(t.toFixed(2))}s</text>`;}).join('');
    let handles='';
    if(key&&next&&key.easing==='bezier'){
      const cp=key.curve??DEFAULT_CURVE;
      handles=[0,1].map(i=>{const hx=px(key.time+(next.time-key.time)*cp[i*2]),hy=py(key.value+(next.value-key.value)*cp[i*2+1]),anchor=i?next:key;
        return`<line x1="${px(anchor.time)}" y1="${py(anchor.value)}" x2="${hx}" y2="${hy}" class="graph-tangent"/><circle cx="${hx}" cy="${hy}" r="6" class="graph-handle" data-handle="${i}" role="button" tabindex="0" aria-label="贝塞尔手柄 ${i+1}"/>`;
      }).join('');
    }
    container.innerHTML=`<div class="graph-toolbar"><div><b>值曲线</b><span>${escape(l.name)}</span></div><label>属性<select id="graph-property" aria-label="曲线属性">${(animated.length?animated:PROPERTIES).map(p=>`<option value="${p}" ${property===p?'selected':''}>${names[p]}</option>`).join('')}</select></label><label>到下一帧<select id="graph-easing" aria-label="曲线缓动" ${!key||!next||l.locked?'disabled':''}>${Object.entries(modes).map(([v,n])=>`<option value="${v}" ${(key?.easing??'linear')===v?'selected':''}>${n}</option>`).join('')}</select></label><span class="graph-hint">${l.locked?'图层已锁定':keys.length<2?'添加至少两个关键帧开始编辑':'拖动键点改时间与值 · 选中前一键点可调手柄'}</span></div>
    <div class="graph-plot"><svg id="value-graph" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="${names[property]}数值曲线">${grid}${ticks}<polyline points="${points}" class="graph-curve"/>${handles}${keys.map((k,i)=>`<circle cx="${px(k.time)}" cy="${py(k.value)}" r="${i===index?6:5}" class="graph-key ${i===index?'active':''}" data-graph-key="${i}" role="button" tabindex="0" aria-label="曲线关键帧 ${i+1} ${k.time.toFixed(2)} 秒 ${Number(k.value.toFixed(3))}"/>`).join('')}<line id="graph-playhead" x1="${px(s.time)}" x2="${px(s.time)}" y1="${TOP}" y2="${H-BOTTOM}"/></svg></div>
    <div class="graph-values">${key&&next&&key.easing==='bezier'?`<span>归一化控制点</span>${['X₁','Y₁','X₂','Y₂'].map((n,i)=>`<label>${n}<input data-curve-point="${i}" aria-label="贝塞尔控制点 ${i+1}" type="number" min="0" max="1" step="0.01" value="${key.curve[i]}" ${l.locked?'disabled':''}></label>`).join('')}${key.value===next.value?'<span>两帧值相同，曲线保持水平</span>':''}`:key?`<span>选中：${key.time.toFixed(3)} 秒 · ${names[property]} ${Number(key.value.toFixed(3))}</span><span>${next?'也可在右侧输入关键帧时间与值':'最后一帧没有出段缓动'}</span>`:'<span>点击圆点选择关键帧；点击图中空白可定位播放头</span>'}</div>`;
    container.querySelector('#graph-property').onchange=e=>{property=e.target.value;host.select(null);host.refreshInspector();render();};
    container.querySelector('#graph-easing').onchange=e=>{const mode=e.target.value;edit(()=>{key.easing=mode;if(mode==='bezier')key.curve=[...DEFAULT_CURVE];else delete key.curve;});};
    for(const input of container.querySelectorAll('[data-curve-point]'))input.onchange=e=>{const value=Number(e.target.value);if(!e.target.value||!Number.isFinite(value)){render();return;}edit(()=>{key.curve[Number(input.dataset.curvePoint)]=clamp(value,0,1);});};
    const svg=container.querySelector('svg');
    const coords=e=>{const rect=container.querySelector('svg').getBoundingClientRect();return[(e.clientX-rect.left)/rect.width*W,(e.clientY-rect.top)/rect.height*H];};
    svg.onpointerdown=e=>{
      if(e.button!==0)return;
      const target=e.target,ki=target.dataset.graphKey,hi=target.dataset.handle;
      if(ki!==undefined){const k=keys[Number(ki)];host.select({property,time:k.time});host.seek(k.time);if(l.locked){render();return;}
        frozenBounds=bounds;
        startDrag(e,ev=>{const[x,y]=coords(ev);moveGraphKey(keys,Number(ki),tAt(x),vAt(y),s.project.fps,s.project.duration,...limits[property]);host.select({property,time:k.time});host.seek(k.time);},()=>host.refreshInspector());
        render();
      }else if(hi!==undefined&&key&&next&&!l.locked){frozenBounds=bounds;startDrag(e,ev=>{const[x,y]=coords(ev);const h=Number(hi)*2;key.curve[h]=clamp((tAt(x)-key.time)/(next.time-key.time),0,1);if(Math.abs(next.value-key.value)>1e-10)key.curve[h+1]=clamp((vAt(y)-key.value)/(next.value-key.value),0,1);key.curve=key.curve.map(n=>Math.round(n*1000)/1000);});
      }else{host.stop();host.seek(clamp(tAt(coords(e)[0]),0,s.project.duration));host.refreshInspector();updatePlayhead();}
    };
    for(const circle of container.querySelectorAll('[data-graph-key]'))circle.onkeydown=e=>{if(!['Enter',' '].includes(e.key))return;e.preventDefault();const k=keys[Number(circle.dataset.graphKey)];host.select({property,time:k.time});host.seek(k.time);host.refreshInspector();render();};
  }
  function updatePlayhead(){if(container.hidden)return;const line=container.querySelector('#graph-playhead');if(!line)return;const s=state(),x=LEFT+s.time/s.project.duration*(W-LEFT-RIGHT);line.setAttribute('x1',x);line.setAttribute('x2',x);}
  return {render,updatePlayhead};
}
