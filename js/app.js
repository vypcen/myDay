// «Тетрадь дней»: интерфейс. Данные — только на устройстве (см. db.js), бэкапы — зашифрованные (см. backup.js).
import { store } from "./db.js";
import { snapshot, backupToBlob, backupToFolder, readBackup, restore, setBackupPassword, getBackupKey, folderSupported, folderState, pickFolder, listFolderBackups } from "./backup.js";

/* ---------- touch helpers ---------- */
const IOS=/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==="MacIntel"&&navigator.maxTouchPoints>1);
if(IOS){const m=document.querySelector('meta[name="viewport"]');if(m&&!/maximum-scale/.test(m.content))m.content+=",maximum-scale=1"} // no auto-zoom when a field gets focus
let lastTouch=0;
addEventListener("pointerdown",e=>{if(e.pointerType!=="mouse")lastTouch=Date.now()},true);
const recentTouch=()=>Date.now()-lastTouch<1200;
// Long press: fires after 480 ms if the finger stays within 10 px.
const LP={t:null,sx:0,sy:0,fired:false,moved:false};
function lpStart(e,fire){lpCancel();LP.fired=false;LP.moved=false;if(e.pointerType==="mouse")return;LP.sx=e.clientX;LP.sy=e.clientY;
  LP.t=setTimeout(()=>{LP.t=null;LP.fired=true;clickBlock=Date.now()+8000;try{navigator.vibrate&&navigator.vibrate(12)}catch(_){}fire(LP.sx,LP.sy)},480)}
function lpMove(e){if(Math.hypot(e.clientX-LP.sx,e.clientY-LP.sy)>10){LP.moved=true;lpCancel()}}
function lpCancel(){if(LP.t){clearTimeout(LP.t);LP.t=null}}
// The finger is still down when the menu opens: swallow the click that its release would produce.
let clickBlock=0;
const blockAfterRelease=()=>{if(clickBlock>Date.now())clickBlock=Date.now()+400};
addEventListener("pointerup",blockAfterRelease,true);addEventListener("pointercancel",blockAfterRelease,true);
for(const t of ["click","mousedown","mouseup"])addEventListener(t,e=>{if(Date.now()<clickBlock){e.stopImmediatePropagation();e.preventDefault()}},true);
let lastTap={t:0,x:0,y:0,id:null};
function isDoubleTap(e,id){const n=Date.now(),d=n-lastTap.t<320&&Math.hypot(e.clientX-lastTap.x,e.clientY-lastTap.y)<30&&lastTap.id===id;
  lastTap=d?{t:0,x:0,y:0,id:null}:{t:n,x:e.clientX,y:e.clientY,id};return d}


const MN=["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];
const MG=["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
const WD=["воскресенье","понедельник","вторник","среда","четверг","пятница","суббота"];
const $=id=>document.getElementById(id);
const pad=n=>String(n).padStart(2,"0");
const key=d=>d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());
const parse=k=>{const[y,m,d]=k.split("-").map(Number);return new Date(y,m-1,d)};
const uid=()=>Math.random().toString(36).slice(2,10);
const now=new Date();
const S={days:{},views:{},y:now.getFullYear(),m:now.getMonth(),open:null};
const W={V:{x:0,y:0,z:1},sel:null,last:null,busy:false,pendingPos:null};
const dirty=new Set(),timers={},inflight={};
const DEFW={text:280,todo:280,image:320,file:280,audio:320};

function examples(){
  const t=key(now),d1=new Date(now);d1.setDate(d1.getDate()+2);const d2=new Date(now);d2.setDate(d2.getDate()-3);
  return {
    [t]:{title:"Пример · План MVP",blocks:[
      {id:uid(),type:"text",x:40,y:40,w:300,color:"y",text:"Это пример пространства дня.\nПравый клик или долгое нажатие на фон — добавить заметку, задачи, картинку, аудио или файл."},
      {id:uid(),type:"todo",x:380,y:60,w:280,items:[{id:uid(),text:"Сетка календаря",done:true},{id:uid(),text:"Свободный холст",done:true},{id:uid(),text:"Вложения",done:false}]}]},
    [key(d1)]:{title:"Пример · Встреча с дизайнером",blocks:[{id:uid(),type:"text",x:40,y:40,w:280,text:"Обсудить тёмную тему и мобильную версию."}]},
    [key(d2)]:{title:"Пример · Идеи",blocks:[{id:uid(),type:"todo",x:40,y:40,w:260,items:[{id:uid(),text:"Поиск по заметкам",done:false}]}]}
  };
}
function norm(d){(d.blocks||(d.blocks=[])).forEach((b,i)=>{if(b.x==null){b.x=40+(i%2)*340;b.y=40+Math.floor(i/2)*240}if(!b.w)b.w=DEFW[b.type]||280});return d}

/* ---------- storage (IndexedDB on this device) ---------- */
function cleanDay(d){return {title:d.title||"",updatedAt:Date.now(),blocks:(d.blocks||[]).filter(b=>!b.uploading).map(b=>{const c={};for(const x in b)if(x[0]!=="_"&&x!=="localUrl"&&x!=="uploading")c[x]=b[x];return c})}}
const isEmpty=d=>!d||(!(d.title||"").trim()&&!(d.blocks||[]).length);

function scheduleSave(k){dirty.add(k);clearTimeout(timers[k]);setStatus("Сохраняю…");timers[k]=setTimeout(()=>flush(k),600);renderCal()}
async function flush(k){
  if(inflight[k])await inflight[k];
  if(!dirty.has(k))return;
  dirty.delete(k);
  const d=S.days[k];
  const p=(async()=>{
    if(isEmpty(d)){delete S.days[k];await store.del("days",k)}
    else{const c=cleanDay(d);d.updatedAt=c.updatedAt;await store.put("days",k,c)}
    await store.put("kv","changedAt",Date.now());
    bc&&bc.postMessage({day:k});
    if(!isEmpty(d))firstContent();
  })();
  inflight[k]=p;
  try{await p;if(!dirty.size)setStatus("Сохранено на этом устройстве")}
  catch(e){dirty.add(k);setStatus(isQuota(e)?"Нет места на устройстве — не сохранено":"Не сохранено — измените что-нибудь, чтобы повторить",true)}
  finally{inflight[k]=null}
}
function setStatus(t,err){const s=$("status");s.textContent=t;s.classList.toggle("err",!!err)}
function day(k){return S.days[k]||(S.days[k]={title:"",blocks:[]})}

/* ---------- calendar ---------- */
function renderCal(){
  $("mName").textContent=MN[S.m];$("mYear").textContent=S.y;
  const first=new Date(S.y,S.m,1),off=(first.getDay()+6)%7,start=new Date(S.y,S.m,1-off),tk=key(new Date());
  const g=$("grid");g.textContent="";
  for(let i=0;i<42;i++){
    const d=new Date(start);d.setDate(start.getDate()+i);const k=key(d),data=S.days[k];
    const b=document.createElement("button");b.className="cell";
    if(d.getMonth()!==S.m)b.classList.add("out");
    if(d.getDay()===0||d.getDay()===6)b.classList.add("we");
    if(k===tk)b.classList.add("today");
    b.setAttribute("aria-label",d.getDate()+" "+MG[d.getMonth()]+(data&&!isEmpty(data)?", есть записи":""));
    b.append(el("span","num",d.getDate()));
    if(data&&!isEmpty(data)){
      b.classList.add("filled");
      const bl=data.blocks||[];const txt=(data.title||"").trim()||((bl.find(x=>x.type==="text"&&(x.text||"").trim())||{}).text||"").split("\n")[0];
      if(txt)b.append(el("span","peek",txt));
      const img=bl.find(x=>x.type==="image"&&(x.fid||x.localUrl));
      if(img){const t=el("img","thumb");t.alt="";setImg(t,img);b.append(t)}
      const ch=el("span","chips");
      const ni=bl.filter(x=>x.type==="image").length,nf=bl.filter(x=>x.type==="file").length,nt=bl.filter(x=>x.type==="text").length;
      const items=bl.filter(x=>x.type==="todo").flatMap(x=>x.items||[]);
      if(items.length)ch.append(el("span","chip","✓ "+items.filter(x=>x.done).length+"/"+items.length));
      if(nt>1)ch.append(el("span","chip","¶ "+nt));
      if(ni)ch.append(el("span","chip","▣ "+ni));{const na=bl.filter(x=>x.type==="audio").length;if(na)ch.append(el("span","chip","♪ "+na))}if(nf)ch.append(el("span","chip","⎙ "+nf));
      if(ch.childNodes.length)b.append(ch);
    }
    b.onclick=()=>openDay(k);
    g.append(b);
  }
}
const URLS={},loadingURL={};
async function ensureURL(id){if(URLS[id])return URLS[id];const f=await store.get("files",id);if(!f||!f.blob)return "";return URLS[id]=URL.createObjectURL(f.blob)}
function fileURL(id){if(URLS[id])return URLS[id];
  if(!loadingURL[id])loadingURL[id]=ensureURL(id).then(u=>{document.querySelectorAll(`img[data-fid="${id}"]`).forEach(e=>{if(u)e.src=u;else e.dispatchEvent(new Event("missing"))})}).catch(()=>{}).finally(()=>{delete loadingURL[id]});
  return ""}
function src(b){return b.localUrl||(b.fid?fileURL(b.fid):"")}
function setImg(im,b){im.dataset.fid=b.fid||"";const u=src(b);if(u)im.src=u}
function el(tag,cls,txt){const e=document.createElement(tag);if(cls)e.className=cls;if(txt!=null)e.textContent=txt;return e}

/* ---------- workspace: view ---------- */
const board=$("board"),plane=$("plane");
function applyView(){const V=W.V;plane.style.transform=`translate(${V.x}px,${V.y}px) scale(${V.z})`;
  paintPattern();board.style.backgroundPosition=`${V.x}px ${V.y}px`;
  $("zoomv").textContent=Math.round(V.z*100)+"%";if(S.open)S.views[S.open]={...V}}
function toCanvas(cx,cy){const r=board.getBoundingClientRect();return {x:Math.round((cx-r.left-W.V.x)/W.V.z),y:Math.round((cy-r.top-W.V.y)/W.V.z)}}
function centerPos(){const r=board.getBoundingClientRect();const p=toCanvas(r.left+r.width/2,r.top+r.height/2);return {x:p.x-130,y:p.y-60}}
function zoomAt(f,cx,cy){const r=board.getBoundingClientRect(),V=W.V;const nz=Math.min(2.5,Math.max(.2,V.z*f));const px=cx-r.left,py=cy-r.top;
  V.x=px-(px-V.x)*nz/V.z;V.y=py-(py-V.y)*nz/V.z;V.z=nz;applyView()}
function zoomCenter(f){const r=board.getBoundingClientRect();zoomAt(f,r.left+r.width/2,r.top+r.height/2)}
function fit(){
  const nodes=[...plane.querySelectorAll(".it:not([hidden])")];const r=board.getBoundingClientRect();
  if(!nodes.length){W.V={x:Math.min(80,r.width*.08),y:Math.min(170,r.height*.25),z:1};applyView();return}
  let x1=1e9,y1=1e9,x2=-1e9,y2=-1e9;
  nodes.forEach(n=>{const x=n.offsetLeft,y=n.offsetTop;x1=Math.min(x1,x);y1=Math.min(y1,y);x2=Math.max(x2,x+n.offsetWidth);y2=Math.max(y2,y+n.offsetHeight)});
  const z=Math.max(.2,Math.min(1,(r.width-80)/(x2-x1||1),(r.height-110)/(y2-y1||1)));
  W.V={z,x:(r.width-(x2-x1)*z)/2-x1*z,y:Math.max(30,(r.height-(y2-y1)*z)/2)-y1*z};applyView();
}

/* ---------- workspace: open/close ---------- */
function openDay(k){
  S.open=k;const d=parse(k);
  if(d.getMonth()!==S.m||d.getFullYear()!==S.y){S.y=d.getFullYear();S.m=d.getMonth();renderCal()}
  try{history.replaceState(null,"","#d"+k)}catch(e){}
  $("ws").hidden=false;document.body.style.overflow="hidden";
  setStatus("Сохраняется на этом устройстве");
  $("wsDate").textContent=d.getDate()+" "+MG[d.getMonth()]+" "+d.getFullYear()+" · "+WD[d.getDay()];
  select(null);renderWs();
  if(S.views[k]){W.V={...S.views[k]};applyView()}else fit();
}
function closeDay(){closeMenu();$("layers")?.remove();S.open=null;$("ws").hidden=true;document.body.style.overflow="";try{history.replaceState(null,"",location.pathname+location.search)}catch(e){}renderCal()}
function shiftDay(n){const d=parse(S.open);d.setDate(d.getDate()+n);openDay(key(d))}

function renderWs(){
  const k=S.open,data=norm(S.days[k]||{title:"",blocks:[]}),d=parse(k);
  const t=$("wsTitle");if(document.activeElement!==t)t.value=data.title||"";
  plane.textContent="";
  plane.append(el("div","bignum",pad(d.getDate())+"."+pad(d.getMonth()+1)));
  data.blocks.forEach(b=>plane.append(renderItem(b)));
  renderLayers();
  plane.querySelectorAll("textarea.txt").forEach(grow);
  
}
$("wsTitle").oninput=e=>{day(S.open).title=e.target.value;scheduleSave(S.open)};

function grow(t){t.style.height="auto";t.style.height=t.scrollHeight+"px"}
function findB(id){return (S.days[S.open]?.blocks||[]).find(b=>b.id===id)}
function nodeOf(id){return plane.querySelector(`.it[data-id="${id}"]`)}
function rerender(b,focusId){const o=nodeOf(b.id),n=renderItem(b);if(o)o.replaceWith(n);else plane.append(n);n.querySelectorAll("textarea.txt").forEach(grow);
  renderLayers();if(focusId){const f=document.getElementById(focusId);f&&f.focus()}}
function select(id){W.sel=id;document.querySelectorAll(".lrow").forEach(r=>r.classList.toggle("sel",r.dataset.id===id));plane.querySelectorAll(".it.sel").forEach(n=>n.classList.remove("sel"));if(id){const n=nodeOf(id);n&&n.classList.add("sel")}}

/* ---------- workspace: items ---------- */
function renderItem(b){
  const k=S.open;
  const n=el("div","it"+(b.color?" c-"+b.color:"")+(b.uploading?" uploading":"")+(W.sel===b.id?" sel":""));
  n.dataset.id=b.id;n.style.left=b.x+"px";n.style.top=b.y+"px";n.style.width=b.w+"px";
  if(b.font&&FONTS[b.font]){n.style.setProperty("--nf",FONTS[b.font].css);n.style.setProperty("--nk",FONTS[b.font].k)}
  if(b.fs&&SIZES[b.fs])n.style.setProperty("--ns",SIZES[b.fs]+"px");
  if(b.type==="text"){
    n.append(el("div","grip","Заметка"));
    const bd=el("div","body");const t=el("textarea","txt");t.id="t-"+b.id;t.placeholder="Пишите здесь…";t.value=b.text||"";t.setAttribute("aria-label","Заметка");
    t.oninput=()=>{b.text=t.value;grow(t);scheduleSave(k)};bd.append(t);n.append(bd);
  } else if(b.type==="todo"){
    const items=b.items||(b.items=[]);
    n.append(el("div","grip","Задачи "+items.filter(x=>x.done).length+"/"+items.length));
    const bd=el("div","body todo");
    items.forEach((it,j)=>{
      const r=el("div","ti"+(it.done?" done":""));
      const c=el("input");c.type="checkbox";c.checked=it.done;c.id="c-"+it.id;c.setAttribute("aria-label","Готово");
      c.onchange=()=>{it.done=c.checked;rerender(b);scheduleSave(k)};
      const tx=el("input");tx.type="text";tx.id="i-"+it.id;tx.value=it.text;tx.placeholder="Задача";
      tx.oninput=()=>{it.text=tx.value;scheduleSave(k)};
      tx.onkeydown=e=>{
        if(e.key==="Enter"){e.preventDefault();const ni={id:uid(),text:"",done:false};items.splice(j+1,0,ni);rerender(b,"i-"+ni.id);scheduleSave(k)}
        if(e.key==="Backspace"&&!tx.value&&items.length>1){e.preventDefault();items.splice(j,1);rerender(b,"i-"+items[Math.max(0,j-1)].id);scheduleSave(k)}
      };
      const x=el("button","x","✕");x.setAttribute("aria-label","Удалить задачу");x.onclick=()=>{items.splice(j,1);rerender(b);scheduleSave(k)};
      r.append(c,tx,x);bd.append(r);
    });
    const add=el("button","addi","+ задача");add.onclick=()=>{const ni={id:uid(),text:"",done:false};items.push(ni);rerender(b,"i-"+ni.id);scheduleSave(k)};
    bd.append(add);n.append(bd);
  } else if(b.type==="image"){
    const w=el("div","imgw");const im=el("img");im.alt=b.caption||b.name||"Картинка";im.draggable=false;
    const gone=()=>{if(!b.uploading){w.textContent="";w.append(el("div","note","Файл картинки не найден на этом устройстве. Его можно вернуть из бэкапа"))}};
    im.onerror=()=>{if(im.getAttribute("src"))gone()};im.addEventListener("missing",gone);setImg(im,b);
    w.append(im);
    const cp=el("input","cap");cp.id="cap-"+b.id;cp.placeholder="Подпись";cp.value=b.caption||"";cp.setAttribute("aria-label","Подпись к картинке");
    cp.oninput=()=>{b.caption=cp.value;scheduleSave(k)};w.append(cp);
    n.append(w);
  } else if(b.type==="audio"){
    n.append(renderAudio(b));
  } else if(b.type==="file"){
    const w=el("div","filew");
    const ext=((b.name||"").includes(".")?(b.name||"").split(".").pop():"файл").slice(0,4);
    w.append(el("div","ext",ext));
    const m=el("div","fmeta");m.append(el("div","fname",b.name),el("div","fsize",size(b.size)));
    const a=el("div","fact");
    if(!b.uploading){
      const dl=el("button",null,"Скачать");dl.onclick=()=>download(b);a.append(dl);
      if(/^(application\/pdf|text\/|image\/|video\/)/.test(b.mime||"")){const o=el("button",null,"Открыть ↗");o.onclick=()=>openFile(b);a.append(o)}
    }
    m.append(a);w.append(m);n.append(w);
  }
  n.append(el("div","rz"));
  if(b.locked){n.classList.add("locked");n.append(el("span","lockb","🔒"))}
  if(b.hidden)n.hidden=true;
  attachDrag(n,b);
  return n;
}
function size(n){if(n==null)return"";return n<1024?n+" Б":n<1048576?(n/1024).toFixed(0)+" КБ":(n/1048576).toFixed(1)+" МБ"}

function attachDrag(n,b){
  n.addEventListener("pointerdown",e=>{
    if(e.button!==0)return;
    closeMenu();select(b.id);
    const t=e.target;
    if(t.closest("input,textarea,button,a,.wave"))return;
    const touch=e.pointerType!=="mouse";
    if(b.locked){if(touch){lpStart(e,(x,y)=>itemMenu(x,y,b));const mv0=ev=>lpMove(ev),up0=ev=>{lpCancel();n.removeEventListener("pointermove",mv0);n.removeEventListener("pointerup",up0);n.removeEventListener("pointercancel",up0)};
      n.addEventListener("pointermove",mv0);n.addEventListener("pointerup",up0);n.addEventListener("pointercancel",up0)}return}
    const resize=t.classList.contains("rz");
    e.preventDefault();e.stopPropagation();
    if(document.activeElement&&document.activeElement!==document.body&&n.contains(document.activeElement)===false)document.activeElement.blur();
    n.setPointerCapture(e.pointerId);W.busy=true;n.classList.add("drag");
    const sx=e.clientX,sy=e.clientY,ox=b.x,oy=b.y,ow=b.w;let moved=false;
    if(touch&&!resize)lpStart(e,(x,y)=>{b.x=ox;b.y=oy;b.w=ow;n.style.left=ox+"px";n.style.top=oy+"px";up(true);itemMenu(x,y,b)});
    const mv=ev=>{if(LP.fired)return;if(touch)lpMove(ev);if(touch&&LP.t)return;const dx=(ev.clientX-sx)/W.V.z,dy=(ev.clientY-sy)/W.V.z;if(Math.abs(dx)+Math.abs(dy)>2)moved=true;
      if(resize){b.w=Math.max(160,Math.round(ow+dx));n.style.width=b.w+"px";n.querySelectorAll("textarea.txt").forEach(grow)}
      else{b.x=Math.round(ox+dx);b.y=Math.round(oy+dy);n.style.left=b.x+"px";n.style.top=b.y+"px"}};
    const up=ev=>{lpCancel();n.removeEventListener("pointermove",mv);n.removeEventListener("pointerup",up);n.removeEventListener("pointercancel",up);
      n.classList.remove("drag");W.busy=false;if(moved&&ev!==true)scheduleSave(S.open);
      if(touch&&ev!==true&&!moved&&!LP.fired&&ev&&ev.type==="pointerup"&&b.type==="image"&&isDoubleTap(ev,b.id))lightboxB(b)};
    n.addEventListener("pointermove",mv);n.addEventListener("pointerup",up);n.addEventListener("pointercancel",up);
  });
  n.addEventListener("dblclick",e=>{e.stopPropagation();if(recentTouch())return;if(b.type==="image"&&!e.target.closest("input"))lightboxB(b)});
}

function addItem(b,pos,focus){
  const k=S.open;b.id=uid();b.x=Math.round(pos.x);b.y=Math.round(pos.y);b.w=b.w||DEFW[b.type];
  day(k).blocks.push(b);const n=renderItem(b);plane.append(n);n.querySelectorAll("textarea.txt").forEach(grow);
  select(b.id);renderLayers();scheduleSave(k);
  if(focus){const f=n.querySelector("textarea,input[type=text]");f&&f.focus({preventScroll:true})}
  return b;
}
function reorder(b,to){const bl=day(S.open).blocks,i=bl.indexOf(b);if(i<0)return;to=Math.max(0,Math.min(bl.length-1,to));if(to===i)return;
  bl.splice(i,1);bl.splice(to,0,b);bl.forEach(x=>{const n=nodeOf(x.id);n&&plane.append(n)});renderLayers();scheduleSave(S.open)}
const front=b=>reorder(b,1e9),back=b=>reorder(b,0);
const up1=b=>reorder(b,day(S.open).blocks.indexOf(b)+1),down1=b=>reorder(b,day(S.open).blocks.indexOf(b)-1);
function toggleHide(b){b.hidden=!b.hidden;if(b.hidden&&W.sel===b.id)select(null);rerender(b);renderLayers();scheduleSave(S.open)}
function toggleLock(b){b.locked=!b.locked;rerender(b);renderLayers();scheduleSave(S.open)}
function duplicate(b){const c=JSON.parse(JSON.stringify(b));if(c.items)c.items.forEach(i=>i.id=uid());addItem(c,{x:b.x+28,y:b.y+28})}

let undo=null;
function removeItem(id){
  const k=S.open,bl=day(k).blocks,i=bl.findIndex(x=>x.id===id);if(i<0)return;
  const [b]=bl.splice(i,1);const n=nodeOf(id);n&&n.remove();select(null);renderLayers();scheduleSave(k);
  if(undo)undo.commit();
  const commit=()=>{clearTimeout(t);undo=null;hideToast();if(b.fid)dropFileIfUnused(b.fid)};
  const t=setTimeout(commit,6000);undo={commit};
  toast("Удалено",["Вернуть",()=>{clearTimeout(t);undo=null;hideToast();day(k).blocks.splice(i,0,b);if(S.open===k)rerender(b);scheduleSave(k)}],6000);
}

/* ---------- board: pan / zoom ---------- */
const pts=new Map();let pan=null,pinch=null;
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
board.addEventListener("pointerdown",e=>{
  if(e.target.closest(".it,.dock"))return;
  closeMenu();
  if(e.button!==0&&e.button!==1)return;
  select(null);if(document.activeElement&&document.activeElement.blur)document.activeElement.blur();
  board.setPointerCapture(e.pointerId);pts.set(e.pointerId,{x:e.clientX,y:e.clientY});
  if(pts.size===1){pan={sx:e.clientX,sy:e.clientY,vx:W.V.x,vy:W.V.y};board.classList.add("panning");
    lpStart(e,(x,y)=>{pts.clear();pan=null;pinch=null;board.classList.remove("panning");bgMenu(x,y,toCanvas(x,y))})}
  else if(pts.size===2){lpCancel();pan=null;const[a,c]=[...pts.values()];pinch={d:dist(a,c),z:W.V.z}}
});
board.addEventListener("pointermove",e=>{
  W.last={x:e.clientX,y:e.clientY};
  if(!pts.has(e.pointerId))return;pts.set(e.pointerId,{x:e.clientX,y:e.clientY});
  if(LP.t)lpMove(e);
  if(pinch&&pts.size===2){const[a,c]=[...pts.values()];zoomAt(pinch.z*dist(a,c)/pinch.d/W.V.z,(a.x+c.x)/2,(a.y+c.y)/2)}
  else if(pan){W.V.x=pan.vx+e.clientX-pan.sx;W.V.y=pan.vy+e.clientY-pan.sy;applyView()}
});
const endPt=e=>{
  if(e.type==="pointerup"&&e.pointerType!=="mouse"&&pts.size===1&&pts.has(e.pointerId)&&!LP.fired&&!LP.moved&&isDoubleTap(e,"board")){
    const p=toCanvas(e.clientX,e.clientY);lpCancel();pts.delete(e.pointerId);pan=null;board.classList.remove("panning");addItem({type:"text",text:""},{x:p.x-20,y:p.y-12},true);return}
  lpCancel();pts.delete(e.pointerId);if(pts.size<2)pinch=null;if(!pts.size){pan=null;board.classList.remove("panning")}};
board.addEventListener("pointerup",endPt);board.addEventListener("pointercancel",endPt);
board.addEventListener("wheel",e=>{
  if(e.target.closest("textarea")&&!e.ctrlKey&&!e.metaKey)return;
  e.preventDefault();closeMenu();
  if(e.ctrlKey||e.metaKey)zoomAt(Math.exp(-e.deltaY*0.0022),e.clientX,e.clientY);
  else{W.V.x-=e.deltaX;W.V.y-=e.deltaY;applyView()}
},{passive:false});
board.addEventListener("dblclick",e=>{if(e.target.closest(".it,.dock,.layers")||recentTouch())return;const p=toCanvas(e.clientX,e.clientY);addItem({type:"text",text:""},{x:p.x-20,y:p.y-12},true)});
$("zIn").onclick=()=>zoomCenter(1.2);$("zOut").onclick=()=>zoomCenter(1/1.2);
$("zoomv").onclick=()=>{zoomCenter(1/W.V.z)};$("zFit").onclick=fit;

/* ---------- context menu ---------- */
let menu=null;
function closeMenu(){if(menu){menu.remove();menu=null}}
function openMenu(cx,cy,entries){
  closeMenu();menu=el("div","ctx");menu.setAttribute("role","menu");
  entries.forEach(en=>{
    if(en==="-"){menu.append(el("hr"));return}
    if(en.fonts){menuFonts(menu,en.b);return}
    if(en.head){menu.append(el("div","mlabel",en.label));return}
    if(en.swatches){const s=el("div","swatches");[["","var(--sheet)","Без цвета"],["y","var(--n-y)","Жёлтый"],["b","var(--n-b)","Голубой"],["g","var(--n-g)","Зелёный"],["p","var(--n-p)","Розовый"]].forEach(([c,bg,l])=>{
      const bt=el("button",en.cur===c?"on":"");bt.style.background=bg;bt.setAttribute("aria-label",l);bt.title=l;bt.onclick=()=>{closeMenu();en.pick(c)};s.append(bt)});menu.append(s);return}
    const bt=el("button",en.danger?"danger":"");bt.setAttribute("role","menuitem");bt.append(el("span","ic",en.ic||""),document.createTextNode(en.label));
    bt.onclick=()=>{closeMenu();en.run()};menu.append(bt);
  });
  document.body.append(menu);
  const r=menu.getBoundingClientRect();
  menu.style.left=Math.max(8,Math.min(cx,innerWidth-r.width-8))+"px";menu.style.top=Math.max(8,Math.min(cy,innerHeight-r.height-8))+"px";
  const f=menu.querySelector("button");f&&f.focus({preventScroll:true});
}
function bgMenu(cx,cy,pos){
  openMenu(cx,cy,[
    {ic:"¶",label:"Заметка",run:()=>addItem({type:"text",text:""},pos,true)},
    {ic:"✓",label:"Список задач",run:()=>addItem({type:"todo",items:[{id:uid(),text:"",done:false}]},pos,true)},
    {ic:"▣",label:"Картинка или файл…",run:()=>{W.pendingPos=pos;$("fileIn").click()}},
    {ic:"♪",label:"Аудио…",run:()=>{W.pendingPos=pos;$("audioIn").click()}},
    "-",
    {ic:"⤢",label:"Показать всё",run:fit}
  ]);
}
function itemMenu(cx,cy,b){
  const en=[];
  if(b.type==="text"||b.type==="todo")en.push({swatches:true,cur:b.color||"",pick:c=>{b.color=c;rerender(b);scheduleSave(S.open)}},{fonts:true,b},"-");
  if(b.type==="image"){en.push({ic:"⛶",label:"Открыть во весь экран",run:()=>lightboxB(b)})}
  if((b.type==="image"||b.type==="file"||b.type==="audio")&&!b.uploading)en.push({ic:"↓",label:"Скачать",run:()=>download(b)});
  if(b.type==="text"||b.type==="todo")en.push({ic:"⧉",label:"Дублировать",run:()=>duplicate(b)});
  const bl=day(S.open).blocks,ix=bl.indexOf(b),top=ix===bl.length-1,bot=ix===0;
  en.push("-",{label:"Слой "+(ix+1)+" из "+bl.length,head:true});
  if(!top)en.push({ic:"⤒",label:"На передний план",run:()=>front(b)},{ic:"↑",label:"Выше на слой",run:()=>up1(b)});
  if(!bot)en.push({ic:"↓",label:"Ниже на слой",run:()=>down1(b)},{ic:"⤓",label:"На задний план",run:()=>back(b)});
  en.push({ic:b.locked?"◌":"⊘",label:b.locked?"Разблокировать":"Заблокировать",run:()=>toggleLock(b)},{ic:"◐",label:"Скрыть",run:()=>toggleHide(b)});
  en.push("-",{ic:"✕",label:"Удалить",danger:true,run:()=>removeItem(b.id)});
  openMenu(cx,cy,en);
}
board.addEventListener("contextmenu",e=>{
  if(e.target.closest("textarea,input"))return; // keep the native menu for text editing
  e.preventDefault();
  if(recentTouch())return; // touch screens use our own long press
  if(e.target.closest(".dock"))return;
  const it=e.target.closest(".it");
  if(it){const b=findB(it.dataset.id);if(b){select(b.id);itemMenu(e.clientX,e.clientY,b)}return}
  bgMenu(e.clientX,e.clientY,toCanvas(e.clientX,e.clientY));
});
$("fab").onclick=e=>{const r=e.currentTarget.getBoundingClientRect();bgMenu(r.right-230,r.top-200,centerPos())};
document.addEventListener("pointerdown",e=>{if(menu&&!menu.contains(e.target))closeMenu()},true);

/* ---------- files ---------- */
const SHOWABLE=/^image\/(png|jpeg|gif|webp|svg\+xml|avif|bmp)$/;
const isQuota=e=>e&&(e.name==="QuotaExceededError"||/quota/i.test(e.message||""));
async function handleFiles(list,pos){
  const k=S.open;if(!k||!list.length)return;
  pos=pos||centerPos();
  for(let i=0;i<list.length;i++){
    const f=list[i];
    const show=SHOWABLE.test(f.type),amime=audioMime(f),fid=uid()+uid();
    const b=addItem({type:amime?"audio":show?"image":"file",name:f.name,size:f.size,mime:amime||f.type||"",fid,uploading:true,localUrl:show?URL.createObjectURL(f):""},{x:pos.x+i*28,y:pos.y+i*28});
    rerender(b);
    try{
      await store.put("files",fid,{name:f.name,mime:amime||f.type||"",size:f.size,created:Date.now(),blob:f});
      if(b.localUrl)URLS[fid]=b.localUrl;
      delete b.uploading;delete b.localUrl;
    }catch(e){
      if(b.localUrl)URL.revokeObjectURL(b.localUrl);
      toast(isQuota(e)?"На устройстве не хватает места для «"+f.name+"»":"Не удалось сохранить «"+f.name+"»");
      const bl=day(k).blocks;const j=bl.indexOf(b);if(j>=0)bl.splice(j,1);const n=nodeOf(b.id);n&&n.remove();
      renderLayers();continue;
    }
    if(S.open===k)rerender(b);scheduleSave(k);
  }
}
async function getBlob(b){const f=b.fid&&await store.get("files",b.fid);if(!f||!f.blob)throw new Error("missing");return f.blob}
function fileInUse(fid){for(const d of Object.values(S.days))for(const x of d.blocks||[])if(x.fid===fid)return true;return false}
async function dropFileIfUnused(fid){if(fileInUse(fid))return;try{await store.del("files",fid)}catch(e){}if(URLS[fid]){URL.revokeObjectURL(URLS[fid]);delete URLS[fid]}}
function saveBlob(blob,name){const u=URL.createObjectURL(blob),a=document.createElement("a");a.href=u;a.download=name;a.rel="noopener";document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),60000)}
async function download(b){try{saveBlob(await getBlob(b),b.name||"файл")}catch(e){toast("Файл не найден на этом устройстве. Его можно вернуть из бэкапа")}}
async function openFile(b){try{const u=await ensureURL(b.fid);if(!u)throw 0;window.open(u,"_blank","noopener")}catch(e){toast("Файл не найден на этом устройстве")}}
async function lightboxB(b){const u=src(b)||(b.fid&&await ensureURL(b.fid));if(u)lightbox(u)}
$("audioIn").onchange=e=>{const fs=[...e.target.files];e.target.value="";handleFiles(fs,W.pendingPos);W.pendingPos=null};
$("fileIn").onchange=e=>{const fs=[...e.target.files];e.target.value="";handleFiles(fs,W.pendingPos);W.pendingPos=null};
let dragDepth=0;
const hasFiles=e=>e.dataTransfer&&[...e.dataTransfer.types].includes("Files");
addEventListener("dragenter",e=>{if(!S.open||!hasFiles(e))return;dragDepth++;$("drop").hidden=false});
addEventListener("dragleave",e=>{if(!S.open||!hasFiles(e))return;if(--dragDepth<=0){dragDepth=0;$("drop").hidden=true}});
addEventListener("dragover",e=>{if(S.open&&hasFiles(e))e.preventDefault()});
addEventListener("drop",e=>{if(!S.open||!hasFiles(e))return;e.preventDefault();dragDepth=0;$("drop").hidden=true;
  const p=toCanvas(e.clientX,e.clientY);handleFiles([...e.dataTransfer.files],{x:p.x-40,y:p.y-30})});
addEventListener("paste",e=>{
  if(!S.open)return;const fs=[...(e.clipboardData&&e.clipboardData.files||[])];if(!fs.length)return;e.preventDefault();
  const r=board.getBoundingClientRect();const l=W.last;
  const p=l&&l.x>r.left&&l.x<r.right&&l.y>r.top&&l.y<r.bottom?toCanvas(l.x,l.y):centerPos();
  handleFiles(fs.map((f,i)=>f.name&&f.name!=="image.png"?f:new File([f],"вставка-"+Date.now()+"-"+i+"."+((f.type.split("/")[1]||"png").replace("jpeg","jpg")),{type:f.type})),p);
});

/* ---------- appearance: palettes, fonts ---------- */
const FONTS={
  golos:{n:"Golos",css:'"Golos Text",system-ui,sans-serif',k:1},
  manrope:{n:"Manrope",css:'"Manrope",system-ui,sans-serif',k:1},
  comfortaa:{n:"Comfortaa",css:'"Comfortaa",system-ui,sans-serif',k:.96},
  unbounded:{n:"Unbounded",css:'"Unbounded",system-ui,sans-serif',k:.9},
  lora:{n:"Lora",css:'"Lora",Georgia,serif',k:1.02},
  playfair:{n:"Playfair",css:'"Playfair Display",Georgia,serif',k:1.03},
  cormorant:{n:"Cormorant",css:'"Cormorant Garamond",Georgia,serif',k:1.18},
  yeseva:{n:"Yeseva One",css:'"Yeseva One",Georgia,serif',k:1.02},
  caveat:{n:"Caveat",css:'"Caveat",cursive',k:1.38},
  marck:{n:"Marck Script",css:'"Marck Script",cursive',k:1.25},
  amatic:{n:"Amatic SC",css:'"Amatic SC",cursive',k:1.5},
  mono:{n:"JetBrains Mono",css:'"JetBrains Mono",ui-monospace,monospace',k:.9}
};
const SIZES={s:13,m:15,l:20,xl:28};
const PALETTES={
  cobalt:{n:"Кобальт",l:["#f3f4f9","#ffffff","#15182a","#3245d1","#ffe169"],d:["#10121b","#1a1d2a","#e7e9f3","#8292ff","#e9c94b"]},
  sage:{n:"Шалфей",l:["#eef2ec","#fbfcf9","#1d2a22","#3f7a5a","#f2d27a"],d:["#0f1511","#18201b","#e3ebe5","#7cc39b","#d9b65a"]},
  dusk:{n:"Сумерки",l:["#f1eef7","#fdfcff","#221a33","#7246c9","#ffd6ea"],d:["#120f1b","#1c1828","#ebe6f6","#b195ff","#f0a6c8"]},
  sea:{n:"Море",l:["#eaf2f4","#fbfeff","#102a33","#0f7c90","#ffe08a"],d:["#0b1619","#132126","#dff0f4","#4cc3d6","#e5c45a"]},
  sakura:{n:"Сакура",l:["#fbf0f2","#fffafb","#2e1a21","#cf3f6a","#ffe3a3"],d:["#1a1014","#24171d","#f6e6eb","#ff8fb0","#e6c27a"]},
  amber:{n:"Янтарь",l:["#f6f0e4","#fffcf5","#2a2014","#b4690e","#cfe8ff"],d:["#15110b","#201a12","#f2e9da","#f2a94a","#8fc2f0"]},
  forest:{n:"Лес",l:["#e9efe6","#f8fbf5","#14241a","#1f6b3a","#ffd36b"],d:["#0b130e","#121d16","#dde9df","#5fd08a","#f0c95a"]},
  graphite:{n:"Графит",l:["#f1f1ef","#ffffff","#141414","#141414","#ffe600"],d:["#0d0d0d","#181818","#ececec","#f0f0f0","#ffe600"]}
};
const ACCENTS=["#3245d1","#7246c9","#cf3f6a","#d4472b","#b4690e","#1f6b3a","#0f7c90","#141414"];
const DEFP={palette:"cobalt",mode:"system",accent:"",fd:"unbounded",fb:"golos",custom:{h:225,s:68,l:48,t:35}};
function hsl2hex(h,s,l){h=((h%360)+360)%360;s/=100;l/=100;const k=n=>(n+h/30)%12,a=s*Math.min(l,1-l);
  const f=n=>Math.round(255*(l-a*Math.max(-1,Math.min(k(n)-3,9-k(n),1))));return "#"+[f(0),f(8),f(4)].map(v=>v.toString(16).padStart(2,"0")).join("")}
function hex2hsl(hex){const m=/^#?([0-9a-f]{6})$/i.exec(hex.trim());if(!m)return null;const n=parseInt(m[1],16);let r=(n>>16&255)/255,g=(n>>8&255)/255,b=(n&255)/255;
  const mx=Math.max(r,g,b),mn=Math.min(r,g,b),l=(mx+mn)/2;let h=0,s=0;if(mx!==mn){const d=mx-mn;s=l>.5?d/(2-mx-mn):d/(mx+mn);
  h=mx===r?(g-b)/d+(g<b?6:0):mx===g?(b-r)/d+2:(r-g)/d+4;h*=60}return {h:Math.round(h),s:Math.round(s*100),l:Math.round(l*100)}}
function customPalette(c){c=c||prefs.custom||DEFP.custom;const{h,s,l}=c,t=(c.t??35)/100,mh=(h+180)%360;
  return {n:"Своя",
    l:[hsl2hex(h,40*t,95.5),hsl2hex(h,45*t,99.3),hsl2hex(h,Math.min(40,s*.5),12),hsl2hex(h,s,Math.min(60,l)),hsl2hex(mh,85,79)],
    d:[hsl2hex(h,32*t,7),hsl2hex(h,26*t,11.5),hsl2hex(h,Math.min(25,s*.3),92),hsl2hex(h,Math.min(100,s*.9+10),Math.max(66,l)),hsl2hex(mh,60,66)]}}
let prefs={...DEFP};
try{const r=localStorage.getItem("tetrad-prefs");if(r)prefs={...DEFP,...JSON.parse(r)}}catch(e){} // быстрый первый кадр; основной источник — IndexedDB

function lum(hex){const n=parseInt(hex.slice(1),16);const c=[n>>16&255,n>>8&255,n&255].map(v=>{v/=255;return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4)});return .2126*c[0]+.7152*c[1]+.0722*c[2]}
const onColor=hex=>lum(hex)>.42?"#141414":"#ffffff";
function applyPrefs(){
  const P=prefs.palette==="custom"?customPalette():(PALETTES[prefs.palette]||PALETTES.cobalt),R=":root:root:root";
  const tok=(a,dark)=>{const acc=prefs.accent||a[3];
    return `--paper:${a[0]};--sheet:${a[1]};--ink:${a[2]};--accent:${acc};--on-accent:${onColor(acc)};--mark:${a[4]};`+
      (dark?"--danger:#ef6b5b;--shadow:rgba(0,0,0,.35);--n-y:#3b3720;--n-b:#1f2a47;--n-g:#1c3428;--n-p:#3a2230;color-scheme:dark;"
           :"--danger:#c0392b;--shadow:rgba(20,24,60,.08);--n-y:#fff6c9;--n-b:#e3ecff;--n-g:#ddf4e4;--n-p:#fde4ee;color-scheme:light;")};
  const fd=FONTS[prefs.fd]||FONTS.unbounded,fb=FONTS[prefs.fb]||FONTS.golos;
  let css=`${R}{--f-display:${fd.css};--k-display:${fd.k};--f-body:${fb.css};--k-body:${fb.k}}`;
  if(prefs.mode==="light")css+=`${R}{${tok(P.l)}}`;
  else if(prefs.mode==="dark")css+=`${R}{${tok(P.d,1)}}`;
  else css+=`${R}{${tok(P.l)}}@media (prefers-color-scheme: dark){${R}:not([data-theme="light"]){${tok(P.d,1)}}}${R}[data-theme="dark"]{${tok(P.d,1)}}`;
  $("themeVars").textContent=css;
  if(typeof refreshTheme==="function")requestAnimationFrame(refreshTheme);
}
let prefsT=null;
function savePrefs(){try{localStorage.setItem("tetrad-prefs",JSON.stringify(prefs))}catch(e){}
  clearTimeout(prefsT);prefsT=setTimeout(()=>{store.put("kv","prefs",JSON.parse(JSON.stringify(prefs))).catch(()=>{})},400)}
function setPref(k,v){prefs[k]=v;applyPrefs();savePrefs();if($("set"))renderSettings()}
async function loadPrefs(){try{const p=await store.get("kv","prefs");if(p){prefs={...DEFP,...p};applyPrefs();try{localStorage.setItem("tetrad-prefs",JSON.stringify(prefs))}catch(e){}}}catch(e){}}

function closeSettings(){const p=$("set");if(p)p.remove()}
function openSettings(){closeMenu();if($("set")){closeSettings();return}const p=el("aside","set");p.id="set";p.setAttribute("role","dialog");p.setAttribute("aria-label","Оформление");document.body.append(p);renderSettings();p.querySelector("button")?.focus({preventScroll:true})}
function renderSettings(){
  const p=$("set");if(!p)return;const st=p.scrollTop;p.textContent="";
  const h=el("div","sethead");h.append(el("h2",null,"Оформление"));const x=el("button","btn icon","✕");x.setAttribute("aria-label","Закрыть");x.onclick=closeSettings;h.append(x);p.append(h);
  const sec=t=>{const s=el("section","sec");s.append(el("h3",null,t));p.append(s);return s};

  const s1=sec("Палитра"),g=el("div","pals");
  [...Object.entries(PALETTES),["custom",customPalette()]].forEach(([k,v])=>{
    const b=el("button","pal"+(prefs.palette===k?" on":""));b.setAttribute("aria-pressed",prefs.palette===k);
    const sw=el("div","sw");[v.l,v.d].forEach(a=>{const i=el("i");i.style.background=a[0];const d=el("b");d.style.background=a[3];const m=el("s");m.style.background=a[4];i.append(d,m);sw.append(i)});
    b.append(sw,el("span",null,k==="custom"?"Своя ◍":v.n));b.onclick=()=>{prefs.accent="";setPref("palette",k)};g.append(b)});
  s1.append(g);
  if(prefs.palette==="custom")s1.append(colorWheel());

  const s2=sec("Режим"),seg=el("div","seg");
  [["light","Светлый"],["dark","Тёмный"],["system","Как в системе"]].forEach(([k,l])=>{const b=el("button",prefs.mode===k?"on":"",l);b.setAttribute("aria-pressed",prefs.mode===k);b.onclick=()=>setPref("mode",k);seg.append(b)});
  s2.append(seg);

  const s3=sec("Акцентный цвет"),row=el("div","accrow"),dots=el("div","dots");
  ACCENTS.forEach(c=>{const b=el("button",prefs.accent===c?"on":"");b.style.background=c;b.setAttribute("aria-label","Акцент "+c);b.onclick=()=>setPref("accent",c);dots.append(b)});
  const ci=el("input");ci.type="color";ci.id="accentPick";ci.value=prefs.accent||(prefs.palette==="custom"?customPalette():(PALETTES[prefs.palette]||PALETTES.cobalt)).l[3];ci.setAttribute("aria-label","Свой цвет");
  let ct=null;ci.oninput=()=>{prefs.accent=ci.value;applyPrefs();clearTimeout(ct);ct=setTimeout(()=>setPref("accent",ci.value),400)};
  const rs=el("button","btn","Как в палитре");rs.onclick=()=>setPref("accent","");
  row.append(dots,ci,rs);s3.append(row);

  const fontSec=(title,key,sample)=>{const s=sec(title),f=el("div","fonts");
    Object.entries(FONTS).forEach(([k,v])=>{const b=el("button","fopt"+(prefs[key]===k?" on":""));b.setAttribute("aria-pressed",prefs[key]===k);
      const sm=el("span","smp",sample);sm.style.fontFamily=v.css;sm.style.fontSize=(20*v.k)+"px";b.append(sm,el("span","fn",v.n));b.onclick=()=>setPref(key,k);f.append(b)});
    s.append(f)};
  fontSec("Шрифт заголовков","fd",MN[S.m]);
  fontSec("Шрифт текста","fb","Утро, кофе, план");
  const s6=sec("Фон холста"),pg=el("div","pats");
  Object.entries(PATTERNS).forEach(([k,v])=>{const b=el("button","pat"+((prefs.bg||"dots")===k?" on":""));b.setAttribute("aria-pressed",(prefs.bg||"dots")===k);
    const pv=el("div","pv");const u=patternURL(k,1);if(u){pv.style.backgroundImage=u;pv.style.backgroundSize=v.w+"px "+v.h+"px"}
    b.append(pv,el("span",null,v.n));b.onclick=()=>setPref("bg",k);pg.append(b)});
  s6.append(pg);
  const sA=[...p.children].find(x=>x.querySelector&&x.querySelector("h3")?.textContent==="Режим");if(sA)p.insertBefore(s6,sA.nextSibling);
  p.scrollTop=st;
}
$("setOpen").onclick=openSettings;$("setOpen2").onclick=openSettings;
document.addEventListener("pointerdown",e=>{const p=$("set");if(p&&!p.contains(e.target)&&!e.target.closest("#setOpen,#setOpen2"))closeSettings()},true);

function menuFonts(m,b){
  m.append(el("div","mlabel","Шрифт"));const g=el("div","fgrid");
  Object.entries(FONTS).forEach(([k,v])=>{const bt=el("button",(b.font||"")===k||(!b.font&&k===prefs.fb)?"on":"",v.n);bt.style.fontFamily=v.css;bt.style.fontSize=Math.round(15*v.k)+"px";
    bt.onclick=()=>{closeMenu();b.font=k;rerender(b);scheduleSave(S.open)};g.append(bt)});
  m.append(g,el("div","mlabel","Размер"));const sz=el("div","sizes");
  [["s","S"],["m","M"],["l","L"],["xl","XL"]].forEach(([k,l])=>{const bt=el("button",(b.fs||"m")===k?"on":"",l);bt.setAttribute("aria-label","Размер "+l);bt.onclick=()=>{closeMenu();b.fs=k;rerender(b);scheduleSave(S.open)};sz.append(bt)});
  m.append(sz);
}

/* ---------- audio ---------- */
const AEXT={mp3:"audio/mpeg",m4a:"audio/mp4",wav:"audio/wav",ogg:"audio/ogg",oga:"audio/ogg",opus:"audio/ogg",aac:"audio/aac",flac:"audio/flac"};
function audioMime(f){if(/^audio\//.test(f.type))return f.type;const e=(f.name||"").split(".").pop().toLowerCase();return AEXT[e]||""}
async function audioSrc(b){if(b.localUrl)return b.localUrl;const u=await ensureURL(b.fid);if(!u)throw new Error("missing");return u}
const fmt=t=>!isFinite(t)?"0:00":Math.floor(t/60)+":"+pad(Math.floor(t%60));
let nowPlaying=null;
function renderAudio(b){
  const w=el("div","audw"),play=el("button","play","▶");play.setAttribute("aria-label","Слушать");
  const meta=el("div","ameta"),wave=el("div","wave");
  let h=0;for(const ch of b.id)h=(h*31+ch.charCodeAt(0))>>>0;
  const N=40;for(let i=0;i<N;i++){h=(h*1103515245+12345)>>>0;const s=el("span");s.style.height=(22+((h>>>8)%78)*Math.sin(Math.PI*(i+.5)/N)**.4)+"%";wave.append(s)}
  const row=el("div","arow"),nm=el("span","an",b.name||"Аудио"),tm=el("span",null,b.uploading?"загружаю…":"0:00");row.append(nm,tm);
  meta.append(wave,row);w.append(play,meta);
  if(b.uploading){play.disabled=true;return w}
  const a=el("audio");a.preload="metadata";w.append(a);
  let loaded=false;
  const load=async()=>{if(loaded)return true;play.disabled=true;try{a.src=await audioSrc(b);loaded=true;return true}catch(e){toast("Аудиофайл не найден на этом устройстве. Его можно вернуть из бэкапа");return false}finally{play.disabled=false}};
  const paint=()=>{const p=a.duration?a.currentTime/a.duration:0;[...wave.children].forEach((s,i)=>s.classList.toggle("on",i<p*N));tm.textContent=fmt(a.currentTime)+" / "+fmt(a.duration)};
  play.onclick=async()=>{if(!await load())return;if(a.paused){if(nowPlaying&&nowPlaying!==a)nowPlaying.pause();nowPlaying=a;a.play().catch(()=>toast("Браузер не смог воспроизвести этот формат"))}else a.pause()};
  a.onplay=()=>{play.textContent="❚❚";play.setAttribute("aria-label","Пауза")};
  a.onpause=a.onended=()=>{play.textContent="▶";play.setAttribute("aria-label","Слушать")};
  a.ontimeupdate=paint;a.onloadedmetadata=paint;
  wave.onclick=async e=>{if(!await load())return;const r=wave.getBoundingClientRect();const go=()=>{a.currentTime=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width))*a.duration;paint()};if(a.readyState>=1)go();else a.addEventListener("loadedmetadata",go,{once:true})};
  if(URLS[b.fid])load();
  return w;
}

/* ---------- colour wheel for a custom palette ---------- */
let wheelImg=null;
function drawWheel(c){const S2=c.width,r=S2/2,ctx=c.getContext("2d");
  if(!wheelImg){wheelImg=ctx.createImageData(S2,S2);const d=wheelImg.data;
    for(let y=0;y<S2;y++)for(let x=0;x<S2;x++){const dx=x-r+.5,dy=y-r+.5,dd=Math.hypot(dx,dy);const i=(y*S2+x)*4;
      if(dd>r){d[i+3]=0;continue}const h=(Math.atan2(dy,dx)*180/Math.PI+360)%360,sat=dd/r*100;
      const hx=hsl2hex(h,sat,50),n=parseInt(hx.slice(1),16);d[i]=n>>16&255;d[i+1]=n>>8&255;d[i+2]=n&255;d[i+3]=dd>r-1?Math.round((r-dd)*255):255}}
  ctx.putImageData(wheelImg,0,0)}
function colorWheel(){
  const c={...DEFP.custom,...prefs.custom};
  const box=el("div","wheelbox"),row=el("div","wheelrow"),wh=el("div","wheel");
  const cv=document.createElement("canvas");cv.width=cv.height=360;cv.setAttribute("aria-label","Цветовой круг");cv.setAttribute("role","slider");
  cv.setAttribute("aria-valuetext","оттенок "+c.h+"°, насыщенность "+c.s+"%");cv.tabIndex=0;
  const knob=el("div","knob");wh.append(cv,knob);drawWheel(cv);
  const side=el("div","wside"),pv=el("div","wprev"),hex=el("input","hexin");hex.id="hexPick";hex.setAttribute("aria-label","Цвет в HEX");hex.maxLength=7;
  side.append(pv,hex);row.append(wh,side);box.append(row);
  const mkSlider=(label,key,min,max,unit)=>{const w=el("label","slider"),top=el("div"),v=el("b");top.append(el("span",null,label),v);
    const r=el("input");r.type="range";r.min=min;r.max=max;r.id="sl-"+key;r.value=c[key];
    r.oninput=()=>{c[key]=+r.value;live()};r.onchange=commit;w.append(top,r);box.append(w);return ()=>{v.textContent=c[key]+unit;r.value=c[key]}};
  let sync=[];
  const paint=()=>{const P=customPalette(c),a=Math.PI*c.h/180,rad=c.s/100*90;
    knob.style.left=(90+Math.cos(a)*rad)+"px";knob.style.top=(90+Math.sin(a)*rad)+"px";knob.style.background=hsl2hex(c.h,c.s,50);
    pv.textContent="";[P.l[0],P.l[3],P.l[4],P.d[0],P.d[3]].forEach(x=>{const i=el("i");i.style.background=x;pv.append(i)});
    if(document.activeElement!==hex)hex.value=P.l[3];sync.forEach(f=>f());
    cv.setAttribute("aria-valuetext","оттенок "+c.h+"°, насыщенность "+c.s+"%")};
  let raf=0;const live=()=>{prefs.custom={...c};prefs.accent="";paint();cancelAnimationFrame(raf);raf=requestAnimationFrame(()=>{quietPanel=true;applyPrefs()})};
  const commit=()=>setPref("custom",{...c});
  const pick=e=>{const r=cv.getBoundingClientRect(),dx=e.clientX-r.left-r.width/2,dy=e.clientY-r.top-r.height/2;
    c.h=Math.round((Math.atan2(dy,dx)*180/Math.PI+360)%360);c.s=Math.round(Math.min(1,Math.hypot(dx,dy)/(r.width/2))*100);live()};
  cv.addEventListener("pointerdown",e=>{cv.setPointerCapture(e.pointerId);pick(e);const mv=ev=>pick(ev);
    const up=()=>{cv.removeEventListener("pointermove",mv);cv.removeEventListener("pointerup",up);cv.removeEventListener("pointercancel",up);commit()};
    cv.addEventListener("pointermove",mv);cv.addEventListener("pointerup",up);cv.addEventListener("pointercancel",up)});
  cv.addEventListener("keydown",e=>{const m={ArrowLeft:[-5,0],ArrowRight:[5,0],ArrowUp:[0,5],ArrowDown:[0,-5]}[e.key];if(!m)return;e.preventDefault();
    c.h=(c.h+m[0]+360)%360;c.s=Math.max(0,Math.min(100,c.s+m[1]));live();clearTimeout(cv._t);cv._t=setTimeout(commit,500)});
  hex.oninput=()=>{const v=hex2hsl(hex.value.startsWith("#")?hex.value:"#"+hex.value);if(!v)return;c.h=v.h;c.s=v.s;c.l=v.l;live()};
  hex.onchange=commit;
  sync=[mkSlider("Яркость акцента","l",25,70,"%"),mkSlider("Оттенок фона","t",0,100,"%")];
  box.append(el("div","hint","Тяните точку по кругу: угол — оттенок, расстояние от центра — насыщенность. Светлая и тёмная версии собираются автоматически."));
  paint();return box;
}

/* ---------- canvas background patterns ---------- */
const PATTERNS={
  dots:{n:"Точки",w:22,h:22,svg:(c,s)=>`<circle cx="11" cy="11" r="${1.15*s}" fill="${c}"/>`},
  bigdots:{n:"Крупные точки",w:34,h:34,svg:(c,s)=>`<circle cx="17" cy="17" r="${2*s}" fill="${c}"/>`},
  grid:{n:"Клетка",w:22,h:22,svg:(c,s)=>`<path d="M0 ${s/2}H22M${s/2} 0V22" stroke="${c}" stroke-width="${s}" fill="none" opacity=".55"/>`},
  lines:{n:"Линейка",w:24,h:28,svg:(c,s)=>`<path d="M0 ${28-s/2}H24" stroke="${c}" stroke-width="${s}" opacity=".85"/>`},
  cross:{n:"Крестики",w:28,h:28,svg:(c,s)=>`<path d="M14 ${14-3.5*s}V${14+3.5*s}M${14-3.5*s} 14H${14+3.5*s}" stroke="${c}" stroke-width="${1.2*s}" stroke-linecap="round"/>`},
  iso:{n:"Изометрия",w:24,h:41.57,svg:(c,s)=>{const r=1.15*s;return `<g fill="${c}"><circle cx="0" cy="0" r="${r}"/><circle cx="24" cy="0" r="${r}"/><circle cx="0" cy="41.57" r="${r}"/><circle cx="24" cy="41.57" r="${r}"/><circle cx="12" cy="20.78" r="${r}"/></g>`}},
  diag:{n:"Диагональ",w:20,h:20,svg:(c,s)=>`<path d="M-5 5L5 -5M0 20L20 0M15 25L25 15" stroke="${c}" stroke-width="${s}" opacity=".7"/>`},
  none:{n:"Без узора",w:22,h:22,svg:null}
};
let dotColor="#c6cadd";
const probe=el("span");probe.style.cssText="position:absolute;width:0;height:0;overflow:hidden;color:var(--dot)";probe.setAttribute("aria-hidden","true");document.body.append(probe);
const cnv=document.createElement("canvas");cnv.width=cnv.height=1;const cx2=cnv.getContext("2d",{willReadFrequently:true});
function resolveDot(){try{cx2.clearRect(0,0,1,1);cx2.fillStyle="#000";cx2.fillStyle=getComputedStyle(probe).color;cx2.fillRect(0,0,1,1);const d=cx2.getImageData(0,0,1,1).data;dotColor=`rgb(${d[0]},${d[1]},${d[2]})`}catch(e){}}
function patternURL(k,z){const P=PATTERNS[k];if(!P||!P.svg)return "";const s=Math.min(4,1/Math.max(.2,z));
  return `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${P.w}" height="${P.h}" viewBox="0 0 ${P.w} ${P.h}">${P.svg(dotColor,s)}</svg>`)}")`}
let patKey="";
function paintPattern(force){
  const k=prefs.bg||"dots",P=PATTERNS[k]||PATTERNS.dots,z=W.V.z,key=k+"|"+z.toFixed(3)+"|"+dotColor;
  board.style.backgroundSize=`${P.w*z}px ${P.h*z}px`;
  if(key===patKey&&!force)return;patKey=key;board.style.backgroundImage=patternURL(k,z)||"none";
}
let quietPanel=false;
function refreshTheme(){resolveDot();patKey="";paintPattern(true);if($("set")&&!quietPanel)renderSettings();quietPanel=false}
try{matchMedia("(prefers-color-scheme: dark)").addEventListener("change",()=>requestAnimationFrame(refreshTheme))}catch(e){}
new MutationObserver(()=>requestAnimationFrame(refreshTheme)).observe(document.documentElement,{attributes:true,attributeFilter:["data-theme","class","style"]});

/* ---------- layers panel ---------- */
let layersOpen=false;
try{layersOpen=localStorage.getItem("tetrad-layers")==="1"}catch(e){}
function toggleLayers(){layersOpen=!layersOpen;try{localStorage.setItem("tetrad-layers",layersOpen?"1":"0")}catch(e){}renderLayers()}
$("lyrBtn").onclick=toggleLayers;
function layerName(b){
  if(b.type==="text")return (b.text||"").trim().split("\n")[0]||"Пустая заметка";
  if(b.type==="todo")return ((b.items||[]).find(i=>i.text.trim())||{}).text||"Список задач";
  if(b.type==="image")return b.caption||b.name||"Картинка";
  return b.name||(b.type==="audio"?"Аудио":"Файл");
}
const LIC={text:"¶",todo:"✓",image:"▣",file:"⎙",audio:"♪"};
let dragRow=null;
function renderLayers(){
  $("lyrBtn").classList.toggle("on",layersOpen);
  let p=$("layers");
  if(!layersOpen||!S.open){p&&p.remove();return}
  if(!p){p=el("div","layers");p.id="layers";p.setAttribute("aria-label","Слои");board.append(p);
    ["pointerdown","wheel","dblclick","contextmenu"].forEach(ev=>p.addEventListener(ev,e=>{e.stopPropagation();if(ev==="contextmenu")e.preventDefault()},{passive:false}))}
  const st=p.querySelector(".llist")?.scrollTop||0;p.textContent="";
  const h=el("div","lhead");h.append(el("b",null,"Слои"));const x=el("button",null,"✕");x.setAttribute("aria-label","Закрыть слои");x.onclick=toggleLayers;h.append(x);p.append(h);
  const bl=(S.days[S.open]?.blocks)||[];
  if(!bl.length){p.append(el("div","lempty","Пока пусто. Добавьте что-нибудь правым кликом или долгим нажатием на холст."));return}
  const nt=el("div","lnote");nt.append(el("span",null,"↑ передний план"),el("span",null,"тяните, чтобы менять"));p.append(nt);
  const ul=el("ul","llist");
  [...bl].reverse().forEach(b=>{
    const li=el("li","lrow"+(W.sel===b.id?" sel":"")+(b.hidden?" off":""));li.dataset.id=b.id;
    const ic=el("span","lic");if(b.type==="image"&&b.fid){const im=el("img");im.alt="";setImg(im,b);ic.append(im)}else ic.textContent=LIC[b.type]||"·";
    const nm=el("span","lname",layerName(b));
    const eye=el("button",b.hidden?"":"act",b.hidden?"◌":"◉");eye.setAttribute("aria-label",b.hidden?"Показать":"Скрыть");eye.title=eye.getAttribute("aria-label");eye.onclick=e=>{e.stopPropagation();toggleHide(b)};
    const lk=el("button",b.locked?"act":"",b.locked?"🔒":"🔓");lk.setAttribute("aria-label",b.locked?"Разблокировать":"Заблокировать");lk.title=lk.getAttribute("aria-label");lk.onclick=e=>{e.stopPropagation();toggleLock(b)};
    const gr=el("span","lgrab","⋮⋮");gr.setAttribute("aria-hidden","true");gr.title="Перетащите, чтобы изменить порядок";
    gr.addEventListener("pointerdown",e=>layerDrag(e,li,b,ul));
    li.append(gr,ic,nm,eye,lk);
    li.onclick=()=>{if(LP.fired)return;if(b.hidden)return;select(b.id);reveal(b)};
    li.oncontextmenu=e=>{e.preventDefault();if(recentTouch())return;select(b.id);itemMenu(e.clientX,e.clientY,b)};
    li.addEventListener("pointerdown",e=>{if(e.target.closest("button,.lgrab"))return;lpStart(e,(x,y)=>{select(b.id);itemMenu(x,y,b)})});
    li.addEventListener("pointermove",e=>{if(LP.t)lpMove(e)});li.addEventListener("pointerup",lpCancel);li.addEventListener("pointercancel",lpCancel);
    ul.append(li);
  });
  p.append(ul);ul.scrollTop=st;
}
function layerDrag(e,li,b,ul){
  e.preventDefault();e.stopPropagation();const gr=e.currentTarget;gr.setPointerCapture(e.pointerId);li.classList.add("lifting");
  let target=null,above=false;
  const clear=()=>ul.querySelectorAll(".lrow").forEach(r=>r.classList.remove("over-top","over-bot"));
  const mv=ev=>{const r=ul.getBoundingClientRect();if(ev.clientY<r.top+20)ul.scrollTop-=8;else if(ev.clientY>r.bottom-20)ul.scrollTop+=8;
    const row=document.elementFromPoint(r.left+r.width/2,ev.clientY)?.closest(".lrow");clear();target=null;
    if(row&&row!==li&&ul.contains(row)){const rr=row.getBoundingClientRect();above=ev.clientY<rr.top+rr.height/2;row.classList.add(above?"over-top":"over-bot");target=row}};
  const up=()=>{gr.removeEventListener("pointermove",mv);gr.removeEventListener("pointerup",up);gr.removeEventListener("pointercancel",up);clear();li.classList.remove("lifting");
    if(!target)return;const tb=findB(target.dataset.id);if(!tb)return;const arr=day(S.open).blocks;
    arr.splice(arr.indexOf(b),1);let ti=arr.indexOf(tb);if(above)ti+=1;arr.splice(ti,0,b); // list is shown top layer first
    arr.forEach(q=>{const n=nodeOf(q.id);n&&plane.append(n)});scheduleSave(S.open);renderLayers();select(b.id)};
  gr.addEventListener("pointermove",mv);gr.addEventListener("pointerup",up);gr.addEventListener("pointercancel",up);
}
function reveal(b){const n=nodeOf(b.id);if(!n)return;const r=board.getBoundingClientRect(),V=W.V;
  const sx=b.x*V.z+V.x,sy=b.y*V.z+V.y,w=n.offsetWidth*V.z,hh=n.offsetHeight*V.z;
  if(sx<300||sy<20||sx+w>r.width-20||sy+hh>r.height-80){V.x=r.width/2-(b.x+n.offsetWidth/2)*V.z;V.y=r.height/2-(b.y+n.offsetHeight/2)*V.z;applyView()}}

/* ---------- ui bits ---------- */
function lightbox(s){if(!s)return;const o=el("div","lb");const im=el("img");im.src=s;im.alt="";o.append(im);o.onclick=()=>o.remove();document.body.append(o)}
let toastEl=null,toastT=null;
function toast(msg,action,ms=4500){hideToast();toastEl=el("div","toast");toastEl.setAttribute("role","status");toastEl.append(el("span",null,msg));
  if(action){const b=el("button",null,action[0]);b.onclick=action[1];toastEl.append(b)}document.body.append(toastEl);toastT=setTimeout(hideToast,ms)}
function hideToast(){clearTimeout(toastT);if(toastEl){toastEl.remove();toastEl=null}}

{const g=$("grid");let sw=null,swiped=0;
  g.addEventListener("pointerdown",e=>{sw=e.pointerType==="mouse"?null:{x:e.clientX,y:e.clientY,t:Date.now()}});
  g.addEventListener("pointerup",e=>{if(!sw)return;const dx=e.clientX-sw.x,dy=e.clientY-sw.y,ok=Math.abs(dx)>60&&Math.abs(dx)>Math.abs(dy)*1.5&&Date.now()-sw.t<800;sw=null;
    if(ok){swiped=Date.now();$(dx<0?"next":"prev").click()}});
  g.addEventListener("pointercancel",()=>{sw=null});
  g.addEventListener("click",e=>{if(Date.now()-swiped<450){e.stopPropagation();e.preventDefault()}},true);}
$("prev").onclick=()=>{S.m--;if(S.m<0){S.m=11;S.y--}renderCal()};
$("next").onclick=()=>{S.m++;if(S.m>11){S.m=0;S.y++}renderCal()};
$("today").onclick=()=>{const t=new Date();S.y=t.getFullYear();S.m=t.getMonth();renderCal()};
$("back").onclick=closeDay;$("dPrev").onclick=()=>shiftDay(-1);$("dNext").onclick=()=>shiftDay(1);
addEventListener("keydown",e=>{
  const typing=/INPUT|TEXTAREA/.test(document.activeElement.tagName);
  if(e.key==="Escape"){const lb=document.querySelector(".lb");if(lb){lb.remove();return}if(menu){closeMenu();return}if($("set")){closeSettings();return}if($("bk")){closeBackup();return}if(typing){document.activeElement.blur();return}if(S.open){if(W.sel)select(null);else closeDay()}return}
  if(S.open&&!typing&&W.sel&&(e.key==="Delete"||e.key==="Backspace")){e.preventDefault();const lb=findB(W.sel);if(lb&&lb.locked){toast("Элемент заблокирован — сначала разблокируйте его");return}removeItem(W.sel);return}
  if(S.open&&!typing&&W.sel&&(e.ctrlKey||e.metaKey)&&(e.code==="BracketRight"||e.code==="BracketLeft")){e.preventDefault();const b=findB(W.sel);if(!b)return;
    if(e.code==="BracketRight")(e.shiftKey?front:up1)(b);else(e.shiftKey?back:down1)(b);return}
  if(S.open&&!typing&&!e.ctrlKey&&!e.metaKey&&e.code==="KeyL"){toggleLayers();return}
  if(!S.open&&!typing){if(e.key==="ArrowLeft")$("prev").click();if(e.key==="ArrowRight")$("next").click()}
});
addEventListener("resize",closeMenu);


/* ---------- data protection: persistence, install, backups ---------- */
const BK={persisted:null,est:null,key:null,dir:null,perm:"none",last:null,lastAuto:null,count:null,busy:false,progress:0,msg:"",err:"",pwForm:false,restore:null};
let installEvt=null;
addEventListener("beforeinstallprompt",e=>{e.preventDefault();installEvt=e;if($("bk"))renderBackup()});
addEventListener("appinstalled",()=>{installEvt=null;refreshBK()});
const isStandalone=()=>matchMedia("(display-mode: standalone)").matches||navigator.standalone===true;
const isIOS=()=>/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==="MacIntel"&&navigator.maxTouchPoints>1);
const ago=t=>{if(!t)return "никогда";const m=Math.round((Date.now()-t)/6e4);if(m<1)return "только что";if(m<60)return m+" мин назад";const h=Math.round(m/60);if(h<24)return h+" ч назад";const d=Math.round(h/24);return d+" "+plural(d,"день","дня","дней")+" назад"};
const plural=(n,a,b,c)=>{const t=n%10,h=n%100;return t===1&&h!==11?a:t>=2&&t<=4&&(h<12||h>14)?b:c};
const mb=n=>n==null?"—":n<1048576?Math.max(1,Math.round(n/1024))+" КБ":n<1073741824?(n/1048576).toFixed(1)+" МБ":(n/1073741824).toFixed(2)+" ГБ";
const fmtDate=t=>{const d=new Date(t);return d.getDate()+" "+MG[d.getMonth()]+" "+d.getFullYear()+", "+pad(d.getHours())+":"+pad(d.getMinutes())};
const stampName=()=>{const d=new Date();return "tetrad-"+key(d)+"_"+pad(d.getHours())+pad(d.getMinutes())+".tetrad"};
const hasData=()=>Object.values(S.days).some(d=>!isEmpty(d));

async function refreshBK(){
  try{BK.persisted=navigator.storage&&navigator.storage.persisted?await navigator.storage.persisted():null}catch(e){BK.persisted=null}
  try{BK.est=navigator.storage&&navigator.storage.estimate?await navigator.storage.estimate():null}catch(e){BK.est=null}
  BK.key=await getBackupKey().catch(()=>null);
  if(folderSupported()){const f=await folderState(false).catch(()=>({dir:null,perm:"none"}));BK.dir=f.dir;BK.perm=f.perm;
    BK.count=f.dir&&f.perm==="granted"?(await listFolderBackups(f.dir).catch(()=>[])).length:null}
  BK.last=await store.get("kv","lastBackup").catch(()=>null);BK.lastAuto=await store.get("kv","lastAuto").catch(()=>null);
  updateBanner();if($("bk"))renderBackup();
}
async function firstContent(){
  if(firstContent.done)return;firstContent.done=true;
  try{if(navigator.storage&&navigator.storage.persist&&!(await navigator.storage.persisted())&&!(await store.get("kv","persistAsked"))){
    await store.put("kv","persistAsked",Date.now());await navigator.storage.persist();refreshBK()}}catch(e){}
}

/* panel */
function closeBackup(){const p=$("bk");if(p)p.remove();BK.restore=null;BK.pwForm=false;BK.err="";BK.rErr="";BK.msg=""}
function openBackup(){closeMenu();closeSettings();if($("bk")){closeBackup();return}const p=el("aside","set");p.id="bk";p.setAttribute("role","dialog");p.setAttribute("aria-label","Данные и бэкап");document.body.append(p);renderBackup();refreshBK();p.querySelector("button")?.focus({preventScroll:true})}
function renderBackup(){
  const p=$("bk");if(!p)return;const st=p.scrollTop;p.textContent="";
  const h=el("div","sethead");h.append(el("h2",null,"Данные и бэкап"));const x=el("button","btn icon","✕");x.setAttribute("aria-label","Закрыть");x.onclick=closeBackup;h.append(x);p.append(h);
  p.append(el("p","bkintro","Все записи и файлы хранятся только на этом устройстве. Никто, включая разработчиков, их не видит. Поэтому сохранность — в ваших руках: защитите хранилище и делайте бэкапы."));
  const sec=t=>{const s=el("section","sec");s.append(el("h3",null,t));p.append(s);return s};
  const line=(parent,ok,text,sub)=>{const r=el("div","stat "+(ok===true?"ok":ok===false?"warn":""));r.append(el("span","sdot"),Object.assign(el("div"),{}));const t=r.lastChild;t.append(el("b",null,text));if(sub)t.append(el("span",null,sub));parent.append(r);return r};
  const btn=(parent,label,fn,cls)=>{const b=el("button","btn"+(cls?" "+cls:""),label);b.onclick=fn;parent.append(b);return b};

  // 1. protection
  const s1=sec("Защита от очистки");
  if(BK.persisted===true)line(s1,true,"Хранилище защищено","Браузер не удалит данные сам, даже при нехватке места.");
  else if(BK.persisted===false){line(s1,false,"Браузер может удалить данные","Так бывает при нехватке места или если долго не открывать приложение (особенно Safari).");
    const r=el("div","row");btn(r,"Защитить хранилище",async()=>{let ok=false;try{ok=await navigator.storage.persist()}catch(e){}
      BK.msg=ok?"":"Браузер пока не разрешил защиту. Установите приложение на устройство — после этого браузер почти всегда разрешает.";await refreshBK()},"primary");s1.append(r)}
  else line(s1,null,"Защита хранилища недоступна в этом браузере","Обязательно настройте бэкапы ниже.");
  if(BK.msg)s1.append(el("p","bknote",BK.msg));
  if(BK.est&&BK.est.usage!=null)s1.append(el("p","bknote","Занято "+mb(BK.est.usage)+(BK.est.quota?" из доступных "+mb(BK.est.quota):"")));
  if(isStandalone())line(s1,true,"Установлено как приложение");
  else if(installEvt){const r=el("div","row");btn(r,"Установить приложение",async()=>{installEvt.prompt();try{await installEvt.userChoice}catch(e){}installEvt=null;refreshBK()});s1.append(r,el("p","bknote","Установленное приложение работает без интернета, а его данные браузер бережёт лучше."))}
  else if(isIOS())s1.append(el("p","bknote","На iPhone и iPad добавьте приложение на экран «Домой»: «Поделиться» → «На экран „Домой“». Без этого Safari может стереть данные, если не открывать приложение около недели."));

  // 2. password
  const s2=sec("Пароль бэкапа");
  if(BK.key&&!BK.pwForm){line(s2,true,"Пароль задан","С "+fmtDate(BK.key.setAt)+". Им шифруется каждый бэкап.");const r=el("div","row");btn(r,"Сменить пароль",()=>{BK.pwForm=true;BK.err="";renderBackup()});s2.append(r)}
  else{
    s2.append(el("p","bknote","Бэкап шифруется этим паролем прямо на устройстве. Пароль нигде не хранится и не восстанавливается: если его забыть, бэкап не открыть никому, включая вас."+(BK.key?" Старые бэкапы по-прежнему открываются старым паролем.":"")));
    const f=el("form","pwf");f.noValidate=true;
    const p1=el("input","inp");p1.type="password";p1.id="pw1";p1.placeholder="Новый пароль, от 8 символов";p1.autocomplete="new-password";
    const p2=el("input","inp");p2.type="password";p2.id="pw2";p2.placeholder="Повторите пароль";p2.autocomplete="new-password";
    const meter=el("div","meter"),bar=el("i");meter.append(bar);const mt=el("span","bknote","");
    p1.oninput=()=>{const sc=strength(p1.value);bar.style.width=(sc*25)+"%";bar.className="m"+sc;mt.textContent=p1.value?["Очень слабый","Слабый","Средний","Хороший","Надёжный"][sc]:""};
    const r=el("div","row"),sb=el("button","btn primary",BK.key?"Сохранить новый пароль":"Задать пароль");sb.type="submit";r.append(sb);
    if(BK.key){const c=el("button","btn","Отмена");c.type="button";c.onclick=()=>{BK.pwForm=false;BK.err="";renderBackup()};r.append(c)}
    f.append(p1,p2,meter,mt,r);if(BK.err)f.append(el("p","bkerr",BK.err));
    f.onsubmit=async e=>{e.preventDefault();BK.err="";
      if(p1.value.length<8)BK.err="Пароль должен быть не короче 8 символов";else if(p1.value!==p2.value)BK.err="Пароли не совпадают";
      if(BK.err){renderBackup();return}
      sb.disabled=true;sb.textContent="Готовлю ключ…";
      try{await setBackupPassword(p1.value);BK.pwForm=false;toast("Пароль бэкапа сохранён. Запишите его в надёжном месте")}catch(err){BK.err="Не удалось сохранить пароль: "+(err.message||err)}
      await refreshBK()};
    s2.append(f);
  }

  // 3. backup now
  const s3=sec("Бэкап");
  line(s3,BK.last?(Date.now()-BK.last.at<7*864e5):false,"Последний бэкап: "+ago(BK.last&&BK.last.at),BK.last?fmtDate(BK.last.at)+" · "+BK.last.days+" "+plural(BK.last.days,"день","дня","дней")+", "+BK.last.files+" "+plural(BK.last.files,"файл","файла","файлов")+(BK.last.where==="folder"?" · в папку":" · скачан"):"Сделайте первый, чтобы не потерять данные.");
  const r3=el("div","row");
  const dl=btn(r3,"Скачать бэкап",()=>doBackup("download"),"primary");dl.disabled=!BK.key||BK.busy;
  if(BK.dir&&BK.perm==="granted"){const fb=btn(r3,"Сохранить в папку",()=>doBackup("folder"));fb.disabled=!BK.key||BK.busy}
  s3.append(r3);
  if(!BK.key)s3.append(el("p","bknote","Сначала задайте пароль бэкапа."));
  if(BK.busy){const pr=el("div","meter"),i=el("i","m4");i.style.width=Math.round(BK.progress*100)+"%";pr.append(i);s3.append(pr,el("p","bknote","Шифрую и сохраняю… "+Math.round(BK.progress*100)+"%"))}
  if(BK.bkErr)s3.append(el("p","bkerr",BK.bkErr));

  // 4. auto folder
  const s4=sec("Автобэкап в папку");
  if(!folderSupported())s4.append(el("p","bknote","В этом браузере автобэкап в папку недоступен (он есть в Chrome, Edge и других браузерах на Chromium на компьютере). Скачивайте бэкап вручную — приложение напомнит, если с последнего прошло больше недели."));
  else if(!BK.dir){
    s4.append(el("p","bknote","Выберите папку, и приложение будет само сохранять туда зашифрованные копии, пока оно открыто: после изменений, не чаще раза в 2 часа. Удобно выбрать папку, которая синхронизируется с облаком (iCloud Drive, Dropbox, Яндекс Диск): облако получит только зашифрованный файл."));
    const r=el("div","row");const b=btn(r,"Выбрать папку",async()=>{try{await pickFolder();await refreshBK();autoBackup(true)}catch(e){if(e&&e.name!=="AbortError")toast("Не удалось открыть папку")}});b.disabled=!BK.key;s4.append(r);
    if(!BK.key)s4.append(el("p","bknote","Сначала задайте пароль бэкапа."));
  } else {
    if(BK.perm==="granted")line(s4,true,"Включён · папка «"+BK.dir.name+"»",(BK.lastAuto?"Последняя копия "+ago(BK.lastAuto.at):"Копий ещё не было")+(BK.count!=null?" · в папке "+BK.count+" "+plural(BK.count,"копия","копии","копий"):""));
    else{line(s4,false,"На паузе · папка «"+BK.dir.name+"»","Браузер просит заново разрешить доступ к папке после перезапуска.");
      const r=el("div","row");btn(r,"Разрешить доступ",async()=>{await folderState(true);await refreshBK();autoBackup(false)},"primary");s4.append(r)}
    const r=el("div","row");btn(r,"Сменить папку",async()=>{try{await pickFolder();await refreshBK();autoBackup(true)}catch(e){}});
    btn(r,"Отключить",async()=>{await store.del("kv","backupDir");await refreshBK()});s4.append(r);
    s4.append(el("p","bknote","Старые копии чистятся постепенно: за последние 2 дня хранятся все, затем по одной на день за 2 недели, на неделю за 2 месяца и на месяц за 2 года. Если данные случайно испортятся, хорошие копии останутся."));
  }

  // 5. restore
  const s5=sec("Восстановить из бэкапа");
  const R=BK.restore;
  if(!R){
    s5.append(el("p","bknote","Откройте файл .tetrad — с этого или другого устройства."));
    const r=el("div","row");const fi=el("input");fi.type="file";fi.accept=".tetrad,application/octet-stream";fi.id="restoreIn";fi.className="sr";
    fi.onchange=()=>{const f=fi.files[0];if(f){BK.restore={file:f,stage:"pw"};BK.rErr="";renderBackup();setTimeout(()=>$("rpw")?.focus(),0)}};
    btn(r,"Выбрать файл бэкапа",()=>fi.click());r.append(fi);s5.append(r);
  } else if(R.stage==="pw"){
    s5.append(el("p","bknote","Файл: "+R.file.name+" · "+mb(R.file.size)));
    const f=el("form","pwf");const pi=el("input","inp");pi.type="password";pi.id="rpw";pi.placeholder="Пароль этого бэкапа";pi.autocomplete="current-password";
    const r=el("div","row"),ob=el("button","btn primary","Открыть");ob.type="submit";ob.id="rOpen";const c=el("button","btn","Отмена");c.type="button";c.onclick=()=>{BK.restore=null;BK.rErr="";renderBackup()};r.append(ob,c);
    f.append(pi,r);if(BK.rErr)f.append(el("p","bkerr",BK.rErr));
    f.onsubmit=async e=>{e.preventDefault();if(!pi.value)return;ob.disabled=true;ob.textContent="Проверяю…";
      try{const {manifest}=await readBackup(R.file,pi.value,{withFiles:false});BK.restore={...R,stage:"preview",pw:pi.value,manifest};BK.rErr=""}
      catch(err){BK.rErr=err.message||"Не удалось открыть бэкап"}renderBackup()};
    s5.append(f);
  } else if(R.stage==="preview"||R.stage==="confirm"){
    const m=R.manifest,nd=Object.keys(m.days).length,nf=m.files.length,sz=m.files.reduce((n,f)=>n+f.size,0);
    line(s5,true,"Бэкап от "+fmtDate(Date.parse(m.created)),nd+" "+plural(nd,"день","дня","дней")+" · "+nf+" "+plural(nf,"файл","файла","файлов")+" ("+mb(sz)+")");
    if(R.stage==="preview"){
      s5.append(el("p","bknote","«Объединить» добавит дни из бэкапа; если день есть и тут, и там, останется более свежая версия. «Заменить всё» удалит текущие данные и вернёт состояние из бэкапа."));
      const r=el("div","row");btn(r,"Объединить",()=>doRestore("merge"),"primary");btn(r,"Заменить всё",()=>{BK.restore={...R,stage:"confirm"};renderBackup()});btn(r,"Отмена",()=>{BK.restore=null;renderBackup()});s5.append(r);
    } else {
      s5.append(el("p","bkerr","Текущие записи и файлы на этом устройстве будут удалены и заменены бэкапом. Если в них есть что-то новое, сначала скачайте бэкап текущих данных."));
      const r=el("div","row");if(BK.key&&hasData())btn(r,"Скачать текущие данные",()=>doBackup("download"));
      btn(r,"Да, заменить всё",()=>doRestore("replace"),"danger");btn(r,"Отмена",()=>{BK.restore={...R,stage:"preview"};renderBackup()});s5.append(r);
    }
  } else if(R.stage==="busy"){
    const pr=el("div","meter"),i=el("i","m4");i.style.width=Math.round((R.progress||0)*100)+"%";pr.append(i);s5.append(pr,el("p","bknote","Расшифровываю и восстанавливаю… "+Math.round((R.progress||0)*100)+"%"));
  }
  if(R&&R.stage!=="pw"&&BK.rErr)s5.append(el("p","bkerr",BK.rErr));
  p.scrollTop=st;
}
function strength(pw){let s=0;if(pw.length>=8)s++;if(pw.length>=12)s++;if(/[a-zа-яё]/.test(pw)&&/[A-ZА-ЯЁ]/.test(pw))s++;if(/\d/.test(pw)&&/[^\wа-яё]/i.test(pw))s++;if(pw.length>=16)s=Math.max(s,3);return Math.min(4,s)}

async function withLock(fn){if(navigator.locks&&navigator.locks.request)return navigator.locks.request("tetrad-backup",{ifAvailable:true},l=>l?fn():null);return fn()}
async function flushAll(){for(const k of [...dirty]){clearTimeout(timers[k]);await flush(k)}}
async function doBackup(where){
  if(BK.busy)return;const kr=await getBackupKey();if(!kr){toast("Сначала задайте пароль бэкапа");return}
  BK.busy=true;BK.progress=0;BK.bkErr="";renderBackup();
  let lastPaint=0;const prog=v=>{BK.progress=v;if(Date.now()-lastPaint>150){lastPaint=Date.now();renderBackup()}};
  try{
    await flushAll();const snap=await snapshot(JSON.parse(JSON.stringify(prefs)));let info,nameOut;
    if(where==="folder"){const f=await folderState(true);if(f.perm!=="granted")throw new Error("Нет доступа к папке");const r=await withLock(()=>backupToFolder(f.dir,snap,kr,prog));if(!r)throw new Error("Бэкап уже идёт в другой вкладке");info=r.info;nameOut=r.name;await store.put("kv","lastAuto",{at:Date.now()})}
    else{const r=await backupToBlob(snap,kr,prog);info=r.info;nameOut=stampName();saveBlob(r.blob,nameOut)}
    await store.put("kv","lastBackup",{at:Date.now(),where,name:nameOut,days:info.days,files:info.files});
    toast(where==="folder"?"Бэкап сохранён в папку":"Бэкап скачан: "+nameOut+". Храните его вне этого устройства");
  }catch(e){BK.bkErr=isQuota(e)?"Не хватает места для бэкапа":"Не удалось сделать бэкап: "+(e.message||e)}
  finally{BK.busy=false;await refreshBK()}
}
async function doRestore(mode){
  const R=BK.restore;if(!R)return;BK.restore={...R,stage:"busy",progress:0};BK.rErr="";renderBackup();
  let lastPaint=0;
  try{
    await flushAll();
    const data=await readBackup(R.file,R.pw,{onProgress:v=>{BK.restore.progress=v;if(Date.now()-lastPaint>150){lastPaint=Date.now();renderBackup()}}});
    const res=await restore(data,mode);
    if(mode==="replace"&&data.manifest.prefs){prefs={...DEFP,...data.manifest.prefs};applyPrefs();savePrefs()}
    await store.put("kv","changedAt",Date.now());
    for(const u of Object.values(URLS))try{URL.revokeObjectURL(u)}catch(e){}for(const k in URLS)delete URLS[k];
    await loadDays();S.views={};if(S.open)closeDay();renderCal();bc&&bc.postMessage({reload:true});
    BK.restore=null;toast(mode==="replace"?"Данные восстановлены из бэкапа":"Готово: добавлено или обновлено "+res.daysIn+" "+plural(res.daysIn,"день","дня","дней"));
  }catch(e){BK.restore={...R,stage:"preview"};BK.rErr=isQuota(e)?"На устройстве не хватает места для восстановления":(e.message||"Не удалось восстановить бэкап")}
  await refreshBK();
}

/* automatic backup to the chosen folder */
async function autoBackup(force){
  if(BK.busy||document.hidden&&!force)return;
  try{
    const kr=await getBackupKey();if(!kr)return;
    const f=await folderState(false);if(f.perm!=="granted"){if(f.dir){BK.perm=f.perm;updateBanner()}return}
    const changed=await store.get("kv","changedAt")||0,last=await store.get("kv","lastAuto");
    if(!force&&last&&(changed<=last.at||Date.now()-last.at<2*36e5))return;
    if(!hasData())return; // never overwrite history with an empty snapshot
    BK.busy=true;await flushAll();
    const snap=await snapshot(JSON.parse(JSON.stringify(prefs)));
    const r=await withLock(()=>backupToFolder(f.dir,snap,kr));
    if(r){const rec={at:Date.now(),where:"folder",name:r.name,days:r.info.days,files:r.info.files};await store.put("kv","lastAuto",rec);await store.put("kv","lastBackup",rec)}
  }catch(e){console.warn("Автобэкап не удался",e)}
  finally{BK.busy=false;refreshBK()}
}
setInterval(()=>autoBackup(false),10*6e4);

/* reminder banner + header badge */
async function updateBanner(){
  const bn=$("banner"),badge=$("bkOpen");if(!bn)return;
  const dismissed=+(localStorage.getItem("tetrad-banner-until")||0)>Date.now();
  let msg="",act="Настроить бэкап",fn=openBackup;
  const last=BK.last&&BK.last.at,old=!last||Date.now()-last>7*864e5;
  if(BK.dir&&BK.perm==="prompt"){msg="Автобэкап на паузе: браузер просит снова разрешить доступ к папке.";act="Разрешить";fn=async()=>{await folderState(true);await refreshBK();autoBackup(false)}}
  else if(hasData()&&old)msg=last?"Последний бэкап был "+ago(last)+". Данные хранятся только на этом устройстве.":"Данные хранятся только на этом устройстве. Сделайте первый бэкап, чтобы не потерять их.";
  badge.classList.toggle("warn",!!msg||(hasData()&&BK.persisted===false));
  if(!msg||dismissed&&!(BK.perm==="prompt")){bn.hidden=true;return}
  bn.hidden=false;bn.textContent="";
  const t=el("span",null,msg),b1=el("button","btn primary",act),b2=el("button","btn","Позже");
  b1.onclick=fn;b2.onclick=()=>{try{localStorage.setItem("tetrad-banner-until",String(Date.now()+864e5))}catch(e){}bn.hidden=true};
  bn.append(t,b1,b2);
}
$("bkOpen").onclick=openBackup;$("bkOpen2").onclick=openBackup;
document.addEventListener("pointerdown",e=>{const p=$("bk");if(p&&!p.contains(e.target)&&!e.target.closest("#bkOpen,#bkOpen2,.banner,.toast"))closeBackup()},true);

/* ---------- other tabs ---------- */
const bc="BroadcastChannel" in window?new BroadcastChannel("tetrad"):null;
if(bc)bc.onmessage=async e=>{
  const m=e.data||{};
  if(m.reload){await loadDays();if(S.open&&!$("ws").contains(document.activeElement))renderWs();renderCal();return}
  if(m.day&&!dirty.has(m.day)&&!inflight[m.day]){const d=await store.get("days",m.day);if(d)S.days[m.day]=d;else delete S.days[m.day];renderCal();
    if(S.open===m.day&&!W.busy&&!$("ws").contains(document.activeElement))renderWs()}
};

/* ---------- offline app shell ---------- */
if("serviceWorker" in navigator&&location.protocol!=="file:"){
  navigator.serviceWorker.register("./sw.js").then(reg=>{
    const offer=w=>toast("Доступна новая версия приложения",["Обновить",()=>{hideToast();w.postMessage("skip")}],60000);
    if(reg.waiting&&navigator.serviceWorker.controller)offer(reg.waiting);
    reg.addEventListener("updatefound",()=>{const w=reg.installing;w&&w.addEventListener("statechange",()=>{if(w.state==="installed"&&navigator.serviceWorker.controller)offer(w)})});
  }).catch(()=>{});
  let reloaded=false;navigator.serviceWorker.addEventListener("controllerchange",()=>{if(reloaded)return;reloaded=true;flushAll().finally(()=>location.reload())});
}
addEventListener("visibilitychange",()=>{if(document.hidden)flushAll()});
addEventListener("pagehide",()=>{flushAll()});

window.__tetrad={S,W}; // для отладки и автотестов
/* ---------- boot ---------- */
async function loadDays(){const all=await store.entries("days");S.days={};for(const [k,d] of all)if(d)S.days[k]=d}
async function boot(){
  applyPrefs();renderCal();
  try{
    await loadPrefs();
    if(!(await store.get("kv","init"))){
      const ex=examples();await store.bulk([...Object.entries(ex).map(([k,v])=>({s:"days",k,v:{...v,updatedAt:1}})),{s:"kv",k:"init",v:Date.now()}]);
    }
    await loadDays();
  }catch(e){$("modeHint").textContent="Хранилище недоступно: "+(e.message||e);console.error(e)}
  renderCal();
  const h=(location.hash||"").match(/^#d(\d{4}-\d{2}-\d{2})$/);if(h)openDay(h[1]);
  await refreshBK();
  setTimeout(()=>autoBackup(false),15000);
}
boot();
