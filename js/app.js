// «Тетрадь дней»: интерфейс. Данные — только на устройстве (см. db.js), бэкапы — зашифрованные (см. backup.js).
import { store, raw, deleteEverything } from "./db.js";
import * as vault from "./vault.js";
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
const S={days:{},views:{},y:now.getFullYear(),m:now.getMonth(),open:null,habits:[],templates:[]};
const W={V:{x:0,y:0,z:1},sel:null,multi:new Set(),mode:"pan",last:null,busy:false,pendingPos:null,penSeen:false,stroke:null,drawBlockId:null,marq:null};
const dirty=new Set(),timers={},inflight={};
const DEFW={text:280,todo:280,image:320,file:280,audio:320,draw:200,sticker:150};

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
function stripB(b){const c={};for(const x in b)if(x[0]!=="_"&&x!=="localUrl"&&x!=="uploading")c[x]=b[x];return c}
function cleanDay(d){const c={title:d.title||"",updatedAt:Date.now(),blocks:(d.blocks||[]).filter(b=>!b.uploading).map(stripB)};
  if(d.mood)c.mood=d.mood;if(d.tag)c.tag=d.tag;if(d.habits&&Object.keys(d.habits).length)c.habits=d.habits;return c}
const hasMarks=d=>!!(d&&(d.mood||d.tag||(d.habits&&Object.keys(d.habits).length)));
const isEmpty=d=>!d||(!(d.title||"").trim()&&!(d.blocks||[]).length&&!hasMarks(d));

function scheduleSave(k){histTouch(k);dirty.add(k);clearTimeout(timers[k]);setStatus("Сохраняю…");timers[k]=setTimeout(()=>flush(k),600);renderCal()}
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
    if(data&&data.tag&&TAGS[data.tag]){b.classList.add("tagged");b.style.setProperty("--tag",TAGS[data.tag])}
    if(data&&data.mood&&MOODS[data.mood-1])b.append(el("span","mood",MOODS[data.mood-1].e));
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
      {const nd=bl.filter(x=>x.type==="draw").length;if(nd)ch.append(el("span","chip","✎ "+nd))}
      if(ch.childNodes.length)b.append(ch);
      const hd=habitDots(data);if(hd)b.append(hd);
    }
    b.onclick=()=>openDay(k);
    g.append(b);
  }
  renderMemo();
}
const URLS={},loadingURL={};
async function ensureURL(id){if(URLS[id])return URLS[id];const f=await store.get("files",id);if(!f||!f.blob)return "";return URLS[id]=URL.createObjectURL(f.blob)}
function fileURL(id){if(URLS[id])return URLS[id];
  if(!loadingURL[id])loadingURL[id]=ensureURL(id).then(u=>{document.querySelectorAll(`img[data-fid="${id}"]`).forEach(e=>{if(u)e.src=u;else e.dispatchEvent(new Event("missing"))})}).catch(()=>{}).finally(()=>{delete loadingURL[id]});
  return ""}
function src(b){return b.localUrl||(b.fid?fileURL(b.fid):"")}
function setImg(im,b){im.dataset.fid=b.fid||"";const u=src(b);if(u)im.src=u}
function el(tag,cls,txt){const e=document.createElement(tag);if(cls)e.className=cls;if(txt!=null)e.textContent=txt;return e}

/* ---------- visible viewport (keyboard on phones) ---------- */
const VV=()=>{const v=window.visualViewport;return v?{h:v.height,t:v.offsetTop}:{h:innerHeight,t:0}};
function syncVV(){const v=VV(),r=document.documentElement.style;r.setProperty("--vvh",v.h+"px");r.setProperty("--vvt",v.t+"px")}
if(window.visualViewport){visualViewport.addEventListener("resize",syncVV);visualViewport.addEventListener("scroll",syncVV)}
addEventListener("resize",syncVV);syncVV();

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
  setMode("pan");select(null);renderWs();histInit(k);renderDayChip();updateUndoBtns();
  if(S.views[k]){W.V={...S.views[k]};applyView()}else fit();
}
function closeDay(){closeMenu();closePop();setMode("pan");if(REC)stopRec(true);$("layers")?.remove();$("selbar")?.remove();S.open=null;$("ws").hidden=true;document.body.style.overflow="";try{history.replaceState(null,"",location.pathname+location.search)}catch(e){}renderCal()}
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
function select(id){W.multi=new Set(id?[id]:[]);W.sel=id;paintSel()}
function toggleSel(id){if(W.multi.has(id))W.multi.delete(id);else W.multi.add(id);W.sel=W.multi.size?[...W.multi].pop():null;paintSel()}
function selectMany(ids){W.multi=new Set(ids);W.sel=ids.length?ids[ids.length-1]:null;paintSel()}
function paintSel(){document.querySelectorAll(".lrow").forEach(r=>r.classList.toggle("sel",W.multi.has(r.dataset.id)));
  plane.querySelectorAll(".it").forEach(n=>n.classList.toggle("sel",W.multi.has(n.dataset.id)));updateSelBar();updateGroupFrame()}
const selBlocks=()=>(S.days[S.open]?.blocks||[]).filter(b=>W.multi.has(b.id));

/* ---------- workspace: items ---------- */
function renderItem(b){
  const k=S.open;
  const n=el("div","it"+(b.uploading?" uploading":"")+(W.multi.has(b.id)?" sel":"")+(b.g?" grp":""));
  n.dataset.id=b.id;n.style.left=b.x+"px";n.style.top=b.y+"px";n.style.width=b.w+"px";applyStyle(n,b);
  if(b.font&&FONTS[b.font]){n.style.setProperty("--nf",FONTS[b.font].css);n.style.setProperty("--nk",FONTS[b.font].k)}
  if(b.fs&&SIZES[b.fs])n.style.setProperty("--ns",SIZES[b.fs]+"px");
  if(b.type==="text"){
    n.append(el("div","grip","Заметка"));
    const bd=el("div","body");const t=el("textarea","txt");t.id="t-"+b.id;t.placeholder="Пишите здесь…";t.value=b.text||"";t.setAttribute("aria-label","Заметка");
    t.oninput=()=>{b.text=t.value;grow(t);scheduleSave(k)};bd.append(t);n.append(bd);
  } else if(b.type==="todo"){
    const items=b.items||(b.items=[]);
    n.append(el("div","grip","Задачи"+(b.label?" · "+b.label:"")+" "+items.filter(x=>x.done).length+"/"+items.length));
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
  } else if(b.type==="draw"){
    n.classList.add("drawit");n.append(drawSVG(b));
  } else if(b.type==="sticker"){
    n.classList.add("stick");
    if(b.emoji){const e=el("span","emo",b.emoji);e.style.fontSize=(b.w*0.8)+"px";n.append(e)}
    else{const im=el("img");im.alt="Стикер";im.draggable=false;setImg(im,b);im.onerror=()=>{if(im.getAttribute("src"))n.classList.add("broken")};n.append(im)}
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
    if(e.button!==0||W.mode==="draw")return;
    closeMenu();closePop();
    const t=e.target;
    if(e.shiftKey&&e.pointerType==="mouse"&&!t.closest("input,textarea")){e.preventDefault();e.stopPropagation();const on=!W.multi.has(b.id);for(const x of groupOf(b))if(W.multi.has(x.id)!==on)toggleSel(x.id);return}
    let inGroup=W.multi.has(b.id)&&W.multi.size>1;
    if(!inGroup){const gm=groupOf(b).filter(x=>!x.hidden);if(gm.length>1){selectMany(gm.map(x=>x.id));inGroup=true}else select(b.id)}
    const touch=e.pointerType!=="mouse";
    if(t.closest("input,textarea,button,a,.wave")){
      // На телефоне заметка почти целиком — поле ввода: долгое нажатие на неактивное поле открывает меню элемента, короткое — начинает ввод.
      if(touch&&t.matches("textarea,input[type=text]")&&document.activeElement!==t){
        lpStart(e,(x,y)=>{t.blur();(inGroup?groupMenu:itemMenu)(x,y,b)});
        const mv0=ev=>lpMove(ev),up0=()=>{lpCancel();n.removeEventListener("pointermove",mv0);n.removeEventListener("pointerup",up0);n.removeEventListener("pointercancel",up0)};
        n.addEventListener("pointermove",mv0);n.addEventListener("pointerup",up0);n.addEventListener("pointercancel",up0)}
      return}
    if(b.locked){if(touch){lpStart(e,(x,y)=>itemMenu(x,y,b));const mv0=ev=>lpMove(ev),up0=ev=>{lpCancel();n.removeEventListener("pointermove",mv0);n.removeEventListener("pointerup",up0);n.removeEventListener("pointercancel",up0)};
      n.addEventListener("pointermove",mv0);n.addEventListener("pointerup",up0);n.addEventListener("pointercancel",up0)}return}
    const resize=t.classList.contains("rz");
    e.preventDefault();e.stopPropagation();
    if(document.activeElement&&document.activeElement!==document.body&&n.contains(document.activeElement)===false)document.activeElement.blur();
    n.setPointerCapture(e.pointerId);W.busy=true;n.classList.add("drag");
    const sx=e.clientX,sy=e.clientY,ox=b.x,oy=b.y,ow=b.w;let moved=false;
    const group=inGroup&&!resize?selBlocks().filter(x=>!x.locked&&x!==b).map(x=>({x,ox:x.x,oy:x.y,n:nodeOf(x.id)})):[];
    const minW=(b.type==="draw"||b.type==="sticker")?40:160;
    if(touch&&!resize)lpStart(e,(x,y)=>{b.x=ox;b.y=oy;b.w=ow;n.style.left=ox+"px";n.style.top=oy+"px";up(true);(inGroup?groupMenu:itemMenu)(x,y,b)});
    const mv=ev=>{if(LP.fired)return;if(touch)lpMove(ev);if(touch&&LP.t)return;const dx=(ev.clientX-sx)/W.V.z,dy=(ev.clientY-sy)/W.V.z;if(Math.abs(dx)+Math.abs(dy)>2)moved=true;
      if(resize){b.w=Math.max(minW,Math.round(ow+dx));n.style.width=b.w+"px";n.querySelectorAll("textarea.txt").forEach(grow);
        const em=n.querySelector(".emo");if(em)em.style.fontSize=(b.w*0.8)+"px"}
      else{b.x=Math.round(ox+dx);b.y=Math.round(oy+dy);n.style.left=b.x+"px";n.style.top=b.y+"px";
        for(const g of group){g.x.x=Math.round(g.ox+dx);g.x.y=Math.round(g.oy+dy);if(g.n){g.n.style.left=g.x.x+"px";g.n.style.top=g.x.y+"px"}}
        if(group.length)updateGroupFrame()}};
    const up=ev=>{lpCancel();n.removeEventListener("pointermove",mv);n.removeEventListener("pointerup",up);n.removeEventListener("pointercancel",up);
      n.classList.remove("drag");W.busy=false;if(moved&&ev!==true){scheduleSave(S.open);histBoundary(S.open)}
      if(inGroup&&!moved&&ev!==true&&!LP.fired&&!b.g)select(b.id);
      if(touch&&ev!==true&&!moved&&!LP.fired&&ev&&ev.type==="pointerup"&&b.type==="image"&&isDoubleTap(ev,b.id))lightboxB(b)};
    n.addEventListener("pointermove",mv);n.addEventListener("pointerup",up);n.addEventListener("pointercancel",up);
  });
  n.addEventListener("dblclick",e=>{e.stopPropagation();if(recentTouch())return;if(b.type==="image"&&!e.target.closest("input"))lightboxB(b)});
}

function addItem(b,pos,focus){
  const k=S.open;b.id=uid();b.x=Math.round(pos.x);b.y=Math.round(pos.y);b.w=b.w||DEFW[b.type];
  histBoundary(k);
  day(k).blocks.push(b);const n=renderItem(b);plane.append(n);n.querySelectorAll("textarea.txt").forEach(grow);
  select(b.id);renderLayers();scheduleSave(k);if(!b.uploading)histBoundary(k);
  if(focus){const f=n.querySelector("textarea,input[type=text]");f&&f.focus({preventScroll:true})}
  return b;
}
function reorder(b,to){const bl=day(S.open).blocks,i=bl.indexOf(b);if(i<0)return;to=Math.max(0,Math.min(bl.length-1,to));if(to===i)return;histBoundary(S.open);
  bl.splice(i,1);bl.splice(to,0,b);bl.forEach(x=>{const n=nodeOf(x.id);n&&plane.append(n)});renderLayers();scheduleSave(S.open)}
const front=b=>reorder(b,1e9),back=b=>reorder(b,0);
const up1=b=>reorder(b,day(S.open).blocks.indexOf(b)+1),down1=b=>reorder(b,day(S.open).blocks.indexOf(b)-1);
function toggleHide(b){b.hidden=!b.hidden;if(b.hidden&&W.sel===b.id)select(null);rerender(b);renderLayers();scheduleSave(S.open)}
function toggleLock(b){b.locked=!b.locked;rerender(b);renderLayers();scheduleSave(S.open)}
function duplicate(b){const c=JSON.parse(JSON.stringify(b));if(c.items)c.items.forEach(i=>i.id=uid());delete c.g;addItem(c,{x:b.x+28,y:b.y+28})}

// Удалённые файлы не стираются сразу: их можно вернуть отменой. Неиспользуемые файлы чистит gcFiles() при запуске.
function removeMany(ids){
  const k=S.open,bl=day(k).blocks;let n=0,locked=0;histBoundary(k);
  for(const id of ids){const i=bl.findIndex(x=>x.id===id);if(i<0)continue;if(bl[i].locked){locked++;continue}bl.splice(i,1);nodeOf(id)?.remove();n++}
  select(null);renderLayers();
  if(!n){if(locked)toast("Заблокированные элементы не удаляются — сначала разблокируйте их");return}
  scheduleSave(k);
  toast(n>1?"Удалено: "+n:"Удалено",["Отменить",()=>{hideToast();if(S.open===k)undoRedo(-1)}],6000);
}
const removeItem=id=>removeMany([id]);

/* ---------- board: pan / zoom ---------- */
const pts=new Map();let pan=null,pinch=null;
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
board.addEventListener("pointerdown",e=>{
  if(e.target.closest(".it,.dock,.layers,.drawbar,.selbar"))return;
  closeMenu();closePop();
  if(e.button!==0&&e.button!==1)return;
  if(e.pointerType==="pen"&&!W.penSeen&&W.mode==="draw"){W.penSeen=true;$("drawbar")?.remove();renderDrawbar()}
  if(e.pointerType==="pen"&&W.mode==="pan"&&e.button===0&&!pts.size){W.penSeen=true;setMode("draw")}
  if(W.mode==="draw"){
    if(e.pointerType==="pen")W.penSeen=true;
    if(W.stroke&&e.pointerType==="touch"&&!W.stroke.erase){const s=W.stroke;drawCancel();pts.set(s.id,s.lastClient);pts.set(e.pointerId,{x:e.clientX,y:e.clientY});board.setPointerCapture(e.pointerId);pan=null;const[a,c]=[...pts.values()];pinch={d:dist(a,c),z:W.V.z};return}
    if(e.button===0&&!pts.size&&!W.stroke&&!(e.pointerType==="touch"&&W.penSeen)){drawStart(e);return}
  }
  if(e.button===0&&!pts.size&&!W.marq&&(W.mode==="select"||(e.shiftKey&&e.pointerType==="mouse"))){marqStart(e);return}
  if(W.marq)return;
  select(null);if(document.activeElement&&document.activeElement.blur)document.activeElement.blur();
  board.setPointerCapture(e.pointerId);pts.set(e.pointerId,{x:e.clientX,y:e.clientY});
  if(pts.size===1){pan={sx:e.clientX,sy:e.clientY,vx:W.V.x,vy:W.V.y};board.classList.add("panning");
    if(W.mode==="pan")lpStart(e,(x,y)=>{pts.clear();pan=null;pinch=null;board.classList.remove("panning");bgMenu(x,y,toCanvas(x,y))})}
  else if(pts.size===2){lpCancel();pan=null;const[a,c]=[...pts.values()];pinch={d:dist(a,c),z:W.V.z}}
});
board.addEventListener("pointermove",e=>{
  W.last={x:e.clientX,y:e.clientY};
  if(W.stroke&&e.pointerId===W.stroke.id){drawMove(e);return}
  if(W.marq&&e.pointerId===W.marq.id){marqMove(e);return}
  if(!pts.has(e.pointerId))return;pts.set(e.pointerId,{x:e.clientX,y:e.clientY});
  if(LP.t)lpMove(e);
  if(pinch&&pts.size===2){const[a,c]=[...pts.values()];zoomAt(pinch.z*dist(a,c)/pinch.d/W.V.z,(a.x+c.x)/2,(a.y+c.y)/2)}
  else if(pan){W.V.x=pan.vx+e.clientX-pan.sx;W.V.y=pan.vy+e.clientY-pan.sy;applyView()}
});
const endPt=e=>{
  if(W.stroke&&e.pointerId===W.stroke.id){drawEnd(e);return}
  if(W.marq&&e.pointerId===W.marq.id){marqEnd(e);return}
  if(e.type==="pointerup"&&e.pointerType!=="mouse"&&pts.size===1&&pts.has(e.pointerId)&&!LP.fired&&!LP.moved&&isDoubleTap(e,"board")){
    const p=toCanvas(e.clientX,e.clientY);lpCancel();pts.delete(e.pointerId);pan=null;board.classList.remove("panning");if(W.mode!=="pan")return;addItem({type:"text",text:""},{x:p.x-20,y:p.y-12},true);return}
  lpCancel();pts.delete(e.pointerId);if(pts.size<2)pinch=null;if(!pts.size){pan=null;board.classList.remove("panning")}};
board.addEventListener("pointerup",endPt);board.addEventListener("pointercancel",endPt);
board.addEventListener("wheel",e=>{
  if(e.target.closest("textarea")&&!e.ctrlKey&&!e.metaKey)return;
  e.preventDefault();closeMenu();
  if(e.ctrlKey||e.metaKey)zoomAt(Math.exp(-e.deltaY*0.0022),e.clientX,e.clientY);
  else{W.V.x-=e.deltaX;W.V.y-=e.deltaY;applyView()}
},{passive:false});
board.addEventListener("dblclick",e=>{if(e.target.closest(".it,.dock,.layers,.drawbar,.selbar")||recentTouch()||W.mode!=="pan")return;const p=toCanvas(e.clientX,e.clientY);addItem({type:"text",text:""},{x:p.x-20,y:p.y-12},true)});
$("zIn").onclick=()=>zoomCenter(1.2);$("zOut").onclick=()=>zoomCenter(1/1.2);
$("zoomv").onclick=()=>{zoomCenter(1/W.V.z)};$("zFit").onclick=fit;

/* ---------- context menu ---------- */
let menu=null;
function closeMenu(){if(menu){menu.remove();menu=null}dropSheetBg()}
// На телефонах меню и панели открываются снизу листом во всю ширину, с прокруткой — не вылезают за экран.
const isPhone=()=>innerWidth<=600||innerHeight<=500;
function sheetify(node){if(!isPhone())return false;node.classList.add("sheet");node.prepend(el("div","grab"));
  if(!$("sheetbg")){const bg=el("div","sheetbg");bg.id="sheetbg";bg.addEventListener("pointerdown",e=>{e.preventDefault();e.stopPropagation();closeMenu();closePop()});document.body.append(bg)}
  return true}
function dropSheetBg(){if(!menu&&!$("pop"))$("sheetbg")?.remove()}
function openMenu(cx,cy,entries){
  closeMenu();menu=el("div","ctx");menu.setAttribute("role","menu");
  entries.forEach(en=>{
    if(en==="-"){menu.append(el("hr"));return}
    if(en.fonts){menuFonts(menu,en.b);return}
    if(en.head){menu.append(el("div","mlabel",en.label));return}
    if(en.swatches){const s=el("div","swatches");QUICK_FILLS.map(f=>[f,fillCss(f)||"var(--sheet)",FILLN[f]]).forEach(([c,bg,l])=>{
      const bt=el("button",en.cur===c?"on":"");bt.style.background=bg;bt.setAttribute("aria-label",l);bt.title=l;bt.onclick=()=>{closeMenu();en.pick(c)};s.append(bt)});menu.append(s);return}
    const bt=el("button",en.danger?"danger":"");bt.setAttribute("role","menuitem");bt.append(el("span","ic",en.ic||""),document.createTextNode(en.label));
    bt.onclick=()=>{closeMenu();en.run()};
    if(en.del){const row=el("div","mrow"),x=el("button","mdel","✕");x.setAttribute("aria-label","Удалить «"+en.label+"»");x.onclick=e=>{e.stopPropagation();closeMenu();en.del()};row.append(bt,x);menu.append(row)}
    else menu.append(bt);
  });
  document.body.append(menu);
  if(sheetify(menu))return;
  const r=menu.getBoundingClientRect(),vh=VV().h;
  menu.style.left=Math.max(8,Math.min(cx,innerWidth-r.width-8))+"px";menu.style.top=Math.max(8,Math.min(cy,vh-r.height-8))+"px";
  const f=menu.querySelector("button");f&&f.focus({preventScroll:true});
}
const COARSE=matchMedia("(pointer:coarse)").matches;
function bgMenu(cx,cy,pos){
  const en=[
    {ic:"¶",label:"Заметка",run:()=>addItem({type:"text",text:""},pos,true)},
    {ic:"✓",label:"Список задач",run:()=>addItem({type:"todo",items:[{id:uid(),text:"",done:false}]},pos,true)},
    {ic:"✎",label:"Рисовать",run:()=>setMode("draw")},
    {ic:"☺",label:"Стикер…",run:()=>openStickers(pos)},
    "-",
    {ic:"▣",label:"Картинка или файл…",run:()=>{W.pendingPos=pos;$("fileIn").click()}}];
  if(COARSE||IOS)en.push({ic:"◉",label:"Снять фото",run:()=>{W.pendingPos=pos;$("camIn").click()}});
  en.push({ic:"●",label:"Записать голос",run:()=>startRec(pos)},
    {ic:"♪",label:"Аудиофайл…",run:()=>{W.pendingPos=pos;$("audioIn").click()}},
    "-",
    {ic:"▤",label:"Шаблон…",run:()=>templateMenu(cx,cy,pos)},
    {ic:"⤢",label:"Показать всё",run:fit});
  openMenu(cx,cy,en);
}
function itemMenu(cx,cy,b){
  const en=[];
  en.push({swatches:true,cur:curFill(b),pick:c=>setStyle([b],{bg:c})},{ic:"◐",label:"Оформление…",run:()=>openStylePop(cx,cy,[b])});
  if(b.type==="text"||b.type==="todo")en.push({fonts:true,b});
  en.push("-");
  if(b.type==="image"){en.push({ic:"⛶",label:"Открыть во весь экран",run:()=>lightboxB(b)})}
  if((b.type==="image"||b.type==="file"||b.type==="audio"||(b.type==="sticker"&&b.fid))&&!b.uploading)en.push({ic:"↓",label:"Скачать",run:()=>download(b)});
  if(b.type==="todo"&&(b.items||[]).some(i=>!i.done&&i.text.trim()))en.push({ic:"→",label:"Перенести незавершённые на завтра",run:()=>carryBlockToTomorrow(b)});
  if(b.type!=="image"&&b.type!=="file"&&b.type!=="audio")en.push({ic:"⧉",label:"Дублировать",run:()=>duplicate(b)});
  if(b.g)en.push({ic:"▢",label:"Разгруппировать",run:()=>{selectMany(groupOf(b).map(x=>x.id));ungroupSel()}});
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
  if(recentTouch()||W.mode==="draw")return; // touch screens use our own long press
  if(e.target.closest(".dock"))return;
  const it=e.target.closest(".it");
  if(it){const b=findB(it.dataset.id);if(b){if(W.multi.has(b.id)&&W.multi.size>1){groupMenu(e.clientX,e.clientY,b);return}select(b.id);itemMenu(e.clientX,e.clientY,b)}return}
  bgMenu(e.clientX,e.clientY,toCanvas(e.clientX,e.clientY));
});
$("fab").onclick=e=>{const r=e.currentTarget.getBoundingClientRect();bgMenu(r.right-230,r.top-200,centerPos())};
document.addEventListener("pointerdown",e=>{if(menu&&!menu.contains(e.target))closeMenu()},true);

/* ---------- files ---------- */
const SHOWABLE=/^image\/(png|jpeg|gif|webp|svg\+xml|avif|bmp)$/;
const isQuota=e=>e&&(e.name==="QuotaExceededError"||/quota/i.test(e.message||""));
async function handleFiles(list,pos,opts={}){
  const k=S.open;if(!k||!list.length)return;
  pos=pos||centerPos();
  for(let i=0;i<list.length;i++){
    let f=list[i];
    if(/^image\//.test(f.type)||/\.(heic|heif)$/i.test(f.name||""))f=await normalizeImage(f,!!opts.sticker);
    const show=SHOWABLE.test(f.type),amime=audioMime(f),fid=uid()+uid();
    const sticker=show&&(opts.sticker||(opts.autoSticker&&await hasAlpha(f)));
    const b=addItem({type:amime?"audio":sticker?"sticker":show?"image":"file",name:f.name,size:f.size,mime:amime||f.type||"",fid,uploading:true,localUrl:show?URL.createObjectURL(f):"",...(sticker?{w:DEFW.sticker}:{})},{x:pos.x+i*28,y:pos.y+i*28});
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
async function gcFiles(){
  try{const used=new Set();for(const d of Object.values(S.days))for(const b of d.blocks||[])if(b.fid)used.add(b.fid);
    const old=Date.now()-864e5;for(const [k,v] of await raw.entries("files"))if(!used.has(k)&&(v&&v.created||0)<old)await store.del("files",k)}catch(e){}}
function saveBlob(blob,name){const u=URL.createObjectURL(blob),a=document.createElement("a");a.href=u;a.download=name;a.rel="noopener";document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),60000)}
async function download(b){try{saveBlob(await getBlob(b),b.name||"файл")}catch(e){toast("Файл не найден на этом устройстве. Его можно вернуть из бэкапа")}}
async function openFile(b){try{const u=await ensureURL(b.fid);if(!u)throw 0;window.open(u,"_blank","noopener")}catch(e){toast("Файл не найден на этом устройстве")}}
async function lightboxB(b){const u=src(b)||(b.fid&&await ensureURL(b.fid));if(u)lightbox(u)}
$("audioIn").onchange=e=>{const fs=[...e.target.files];e.target.value="";handleFiles(fs,W.pendingPos);W.pendingPos=null};
$("camIn").onchange=e=>{const fs=[...e.target.files];e.target.value="";handleFiles(fs,W.pendingPos);W.pendingPos=null};
$("stickIn").onchange=e=>{const fs=[...e.target.files];e.target.value="";closeStickers();handleFiles(fs,W.stickPos,{sticker:true})};
$("fileIn").onchange=e=>{const fs=[...e.target.files];e.target.value="";handleFiles(fs,W.pendingPos);W.pendingPos=null};
let dragDepth=0;
const hasFiles=e=>e.dataTransfer&&[...e.dataTransfer.types].includes("Files");
addEventListener("dragenter",e=>{if(!S.open||!hasFiles(e))return;dragDepth++;$("drop").hidden=false});
addEventListener("dragleave",e=>{if(!S.open||!hasFiles(e))return;if(--dragDepth<=0){dragDepth=0;$("drop").hidden=true}});
addEventListener("dragover",e=>{if(S.open&&hasFiles(e))e.preventDefault()});
addEventListener("drop",e=>{if(!S.open||!hasFiles(e))return;e.preventDefault();dragDepth=0;$("drop").hidden=true;
  const p=toCanvas(e.clientX,e.clientY);handleFiles([...e.dataTransfer.files],{x:p.x-40,y:p.y-30})});
addEventListener("paste",e=>{
  if(!S.open||e.target.closest&&e.target.closest(".stsheet,input,textarea"))return;const fs=[...(e.clipboardData&&e.clipboardData.files||[])];if(!fs.length)return;e.preventDefault();
  const r=board.getBoundingClientRect();const l=W.last;
  const p=l&&l.x>r.left&&l.x<r.right&&l.y>r.top&&l.y<r.bottom?toCanvas(l.x,l.y):centerPos();
  handleFiles(fs.map((f,i)=>f.name&&f.name!=="image.png"?f:new File([f],"вставка-"+Date.now()+"-"+i+"."+((f.type.split("/")[1]||"png").replace("jpeg","jpg")),{type:f.type})),p,{autoSticker:true});
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
      (dark?"--danger:#ef6b5b;--shadow:rgba(0,0,0,.35);--n-y:#3b3720;--n-b:#1f2a47;--n-g:#1c3428;--n-p:#3a2230;--n-o:#41290f;--n-r:#46201f;--n-v:#2d2448;--n-t:#123a36;--n-k:#e8eaf2;--n-kf:#14161f;color-scheme:dark;"
           :"--danger:#c0392b;--shadow:rgba(20,24,60,.08);--n-y:#fff6c9;--n-b:#e3ecff;--n-g:#ddf4e4;--n-p:#fde4ee;--n-o:#ffe6cc;--n-r:#fde0de;--n-v:#ebe3ff;--n-t:#d5f2ee;--n-k:#262a36;--n-kf:#f4f5fa;color-scheme:light;")};
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
  if(b.type==="draw")return "Рисунок";
  if(b.type==="sticker")return b.emoji?"Стикер "+b.emoji:"Стикер";
  return b.name||(b.type==="audio"?"Аудио":"Файл");
}
const LIC={text:"¶",todo:"✓",image:"▣",file:"⎙",audio:"♪",draw:"✎",sticker:"☺"};
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
    const li=el("li","lrow"+(W.multi.has(b.id)?" sel":"")+(b.hidden?" off":""));li.dataset.id=b.id;
    const ic=el("span","lic");if((b.type==="image"||b.type==="sticker")&&b.fid){const im=el("img");im.alt="";setImg(im,b);ic.append(im)}else ic.textContent=(b.type==="sticker"&&b.emoji)||LIC[b.type]||"·";
    const nm=el("span","lname",layerName(b));if(b.g){nm.prepend(el("span","lgrp","◫ "));nm.title="В группе"}
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
function reveal(b,force){const n=nodeOf(b.id);if(!n)return;const r=board.getBoundingClientRect(),V=W.V;
  const sx=b.x*V.z+V.x,sy=b.y*V.z+V.y,w=n.offsetWidth*V.z,hh=n.offsetHeight*V.z;
  if(force||sx<300||sy<20||sx+w>r.width-20||sy+hh>r.height-80){V.x=r.width/2-(b.x+n.offsetWidth/2)*V.z;V.y=r.height/2-(b.y+n.offsetHeight/2)*V.z;applyView()}}

/* ---------- undo / redo: snapshots of the open day ---------- */
const HIST={};let histTimer=null;
function serializeDay(d){d=d||{};return JSON.stringify({title:d.title||"",mood:d.mood||0,tag:d.tag||"",habits:d.habits||{},blocks:(d.blocks||[]).filter(b=>!b.uploading).map(stripB)})}
function histInit(k){if(!HIST[k])HIST[k]={stack:[serializeDay(S.days[k])],i:0};updateUndoBtns()}
// Граница шага отмены: незавершённые правки (например, набор текста) фиксируются отдельно от следующего действия.
function histBoundary(k){if(k===S.open&&HIST[k])histCommit(k)}
function histTouch(k){if(k!==S.open||!HIST[k])return;clearTimeout(histTimer);histTimer=setTimeout(()=>histCommit(k),350);updateUndoBtns()}
function histCommit(k){
  clearTimeout(histTimer);histTimer=null;const H=HIST[k];if(!H)return;
  const d=S.days[k];if(d&&(d.blocks||[]).some(b=>b.uploading)){histTimer=setTimeout(()=>histCommit(k),400);return}
  const snap=serializeDay(d);if(snap===H.stack[H.i])return;
  H.stack=H.stack.slice(0,H.i+1);H.stack.push(snap);if(H.stack.length>150)H.stack.shift();H.i=H.stack.length-1;updateUndoBtns();
}
function undoRedo(dir){
  const k=S.open;if(!k)return;if(histTimer)histCommit(k);const H=HIST[k];if(!H)return;
  const ni=H.i+dir;if(ni<0||ni>=H.stack.length){toast(dir<0?"Нечего отменять":"Нечего повторять",null,1500);return}
  H.i=ni;const v=JSON.parse(H.stack[ni]),cur=S.days[k]||{};
  const nd={...cur,title:v.title,blocks:v.blocks};
  for(const f of ["mood","tag"])if(v[f])nd[f]=v[f];else delete nd[f];
  if(Object.keys(v.habits).length)nd.habits=v.habits;else delete nd.habits;
  S.days[k]=nd;setMode("pan");renderWs();select(null);renderDayChip();
  dirty.add(k);clearTimeout(timers[k]);setStatus("Сохраняю…");timers[k]=setTimeout(()=>flush(k),300);renderCal();updateUndoBtns();
}
function updateUndoBtns(){const H=S.open&&HIST[S.open];const u=$("undoBtn"),r=$("redoBtn");if(!u)return;
  u.disabled=!H||H.i<=0&&!histTimer;r.disabled=!H||H.i>=H.stack.length-1}
$("undoBtn").onclick=()=>undoRedo(-1);$("redoBtn").onclick=()=>undoRedo(1);

/* ---------- canvas modes: pan / draw / select ---------- */
function setMode(m){
  if(W.mode===m)return;
  if(W.stroke)drawCancel();if(W.marq)marqCancel();
  W.mode=m;W.drawBlockId=null;
  board.classList.toggle("drawing",m==="draw");board.classList.toggle("selecting",m==="select");
  $("drawBtn").classList.toggle("on",m==="draw");$("selBtn").classList.toggle("on",m==="select");
  $("drawbar")?.remove();if(m==="draw"){select(null);renderDrawbar()}
}
$("drawBtn").onclick=()=>setMode(W.mode==="draw"?"pan":"draw");
$("selBtn").onclick=()=>setMode(W.mode==="select"?"pan":"select");

/* ---------- drawing ---------- */
const NS="http://www.w3.org/2000/svg";
const DCOLORS=["ink","accent","#e5484d","#f59e0b","#22a06b","#3b82f6","#8b5cf6","#ffffff"];
const DSIZES={pen:[2,4,8],marker:[12,20,32]};
let DT={tool:"pen",color:"ink",size:1};
try{const r=JSON.parse(localStorage.getItem("tetrad-draw")||"null");if(r&&DSIZES[r.tool]||r&&r.tool==="eraser")DT={...DT,...r}}catch(e){}
const saveDT=()=>{try{localStorage.setItem("tetrad-draw",JSON.stringify(DT))}catch(e){}};
const dcol=c=>c==="ink"?"var(--ink)":c==="accent"?"var(--accent)":c;
function pathD(p){const n=p.length/2;if(n<2)return `M${p[0]} ${p[1]}l0.01 0`;let d=`M${p[0]} ${p[1]}`;
  for(let i=1;i<n-1;i++){const x=p[2*i],y=p[2*i+1];d+=`Q${x} ${y} ${((x+p[2*i+2])/2).toFixed(1)} ${((y+p[2*i+3])/2).toFixed(1)}`}
  return d+`L${p[2*n-2]} ${p[2*n-1]}`}
function strokeEl(st){const p=document.createElementNS(NS,"path");p.setAttribute("d",pathD(st.p));p.style.stroke=dcol(st.c);p.setAttribute("stroke-width",st.s);
  if(st.o<1)p.setAttribute("stroke-opacity",st.o);p.setAttribute("fill","none");p.setAttribute("stroke-linecap","round");p.setAttribute("stroke-linejoin","round");return p}
function drawSVG(b){const svg=document.createElementNS(NS,"svg");svg.setAttribute("viewBox",`0 0 ${b.vw} ${b.vh}`);svg.setAttribute("class","dsvg");
  svg.style.aspectRatio=b.vw+" / "+b.vh;for(const st of b.strokes||[])svg.append(strokeEl(st));return svg}
function renderDrawbar(){
  const bar=el("div","drawbar");bar.id="drawbar";
  const grp=()=>{const g=el("div","dgrp");bar.append(g);return g};
  const g1=grp();
  [["pen","✎","Перо"],["marker","▬","Маркер"],["eraser","⌫","Ластик"]].forEach(([t,ic,l])=>{const b=el("button",DT.tool===t?"on":"",ic);b.title=l;b.setAttribute("aria-label",l);
    b.onclick=()=>{DT.tool=t;saveDT();$("drawbar").remove();renderDrawbar()};g1.append(b)});
  if(DT.tool!=="eraser"){
    const g2=grp();DCOLORS.forEach(c=>{const b=el("button","dsw"+(DT.color===c?" on":""));b.style.background=dcol(c);b.setAttribute("aria-label","Цвет");
      b.onclick=()=>{DT.color=c;saveDT();$("drawbar").remove();renderDrawbar()};g2.append(b)});
    const g3=grp();DSIZES[DT.tool].forEach((sz,i)=>{const b=el("button","dsz"+(DT.size===i?" on":""));const dot=el("i");const v=Math.min(18,4+i*5);dot.style.width=dot.style.height=v+"px";b.append(dot);
      b.setAttribute("aria-label","Толщина "+(i+1));b.onclick=()=>{DT.size=i;saveDT();$("drawbar").remove();renderDrawbar()};g3.append(b)});
  }
  if(W.penSeen)bar.append(el("span","dhint","Пальцем — двигать холст · тап двумя пальцами — отменить"));
  const done=el("button","btn primary dk","Готово");done.onclick=()=>setMode("pan");bar.append(done);
  ["pointerdown","dblclick","contextmenu","wheel"].forEach(ev=>bar.addEventListener(ev,e=>{e.stopPropagation();if(ev==="contextmenu")e.preventDefault()},{passive:false}));
  board.append(bar);
}
function toCanvasF(cx,cy){const r=board.getBoundingClientRect();return {x:Math.round((cx-r.left-W.V.x)/W.V.z*10)/10,y:Math.round((cy-r.top-W.V.y)/W.V.z*10)/10}}
function drawStart(e){
  board.setPointerCapture(e.pointerId);histBoundary(S.open);
  if(DT.tool==="eraser"){W.stroke={id:e.pointerId,erase:true,changed:false,lastClient:{x:e.clientX,y:e.clientY}};eraseAt(e);return}
  const p=toCanvasF(e.clientX,e.clientY),marker=DT.tool==="marker";
  const st={c:DT.color,s:DSIZES[DT.tool][DT.size]||4,o:marker?.35:1,p:[p.x,p.y]};
  const live=document.createElementNS(NS,"svg");live.setAttribute("class","live");const path=strokeEl(st);live.append(path);plane.append(live);
  W.stroke={id:e.pointerId,st,live,path,raf:0,lastClient:{x:e.clientX,y:e.clientY}};
}
function drawMove(e){
  const S2=W.stroke;S2.lastClient={x:e.clientX,y:e.clientY};
  const evs=e.getCoalescedEvents?e.getCoalescedEvents():[e];
  if(S2.erase){for(const ev of evs.length?evs:[e])eraseAt(ev);return}
  const min=0.9/W.V.z,p=S2.st.p;
  for(const ev of evs.length?evs:[e]){const c=toCanvasF(ev.clientX,ev.clientY);const lx=p[p.length-2],ly=p[p.length-1];if(Math.hypot(c.x-lx,c.y-ly)>=min)p.push(c.x,c.y)}
  if(!S2.raf)S2.raf=requestAnimationFrame(()=>{S2.raf=0;S2.path.setAttribute("d",pathD(S2.st.p))});
}
function drawCancel(){const S2=W.stroke;if(!S2)return;S2.live?.remove();if(S2.raf)cancelAnimationFrame(S2.raf);W.stroke=null}
function drawEnd(){
  const S2=W.stroke;W.stroke=null;if(!S2)return;
  if(S2.erase){if(S2.changed){renderLayers();scheduleSave(S.open);histBoundary(S.open)}return}
  if(S2.raf)cancelAnimationFrame(S2.raf);S2.live.remove();
  const st=S2.st;if(st.p.length===2)st.p.push(st.p[0]+0.1,st.p[1]);
  const cur=W.drawBlockId&&findB(W.drawBlockId);
  const abs=cur?absStrokes(cur):[];abs.push(st);
  if(cur){rebaseDraw(cur,abs);rerender(cur);scheduleSave(S.open);histBoundary(S.open)}
  else{const b={type:"draw",strokes:[]};const o=rebaseDraw(b,abs);addItem(b,{x:o.x,y:o.y});W.drawBlockId=b.id;select(null)}
}
function absStrokes(b){const k=b.w/b.vw;return (b.strokes||[]).map(st=>({...st,s:+(st.s*k).toFixed(2),p:st.p.map((v,i)=>+((i%2?b.y:b.x)+v*k).toFixed(1))}))}
function rebaseDraw(b,abs){
  let x1=1e9,y1=1e9,x2=-1e9,y2=-1e9;
  for(const st of abs){const r=st.s/2+2;for(let i=0;i<st.p.length;i+=2){x1=Math.min(x1,st.p[i]-r);x2=Math.max(x2,st.p[i]+r);y1=Math.min(y1,st.p[i+1]-r);y2=Math.max(y2,st.p[i+1]+r)}}
  const ox=Math.floor(x1),oy=Math.floor(y1);
  b.x=ox;b.y=oy;b.vw=Math.max(1,Math.ceil(x2)-ox);b.vh=Math.max(1,Math.ceil(y2)-oy);b.w=b.vw;
  b.strokes=abs.map(st=>({...st,p:st.p.map((v,i)=>+(v-(i%2?oy:ox)).toFixed(1))}));
  return {x:ox,y:oy};
}
function segDist(px,py,ax,ay,bx,by){const dx=bx-ax,dy=by-ay,l=dx*dx+dy*dy;let t=l?((px-ax)*dx+(py-ay)*dy)/l:0;t=Math.max(0,Math.min(1,t));return Math.hypot(px-ax-t*dx,py-ay-t*dy)}
function eraseAt(e){
  const c=toCanvasF(e.clientX,e.clientY),R=(COARSE?14:9)/W.V.z,bl=day(S.open).blocks;
  for(let bi=bl.length-1;bi>=0;bi--){const b=bl[bi];if(b.type!=="draw"||b.hidden||b.locked)continue;
    const k=b.w/b.vw,h=b.vh*k;if(c.x<b.x-R||c.y<b.y-R||c.x>b.x+b.w+R||c.y>b.y+h+R)continue;
    const lx=(c.x-b.x)/k,ly=(c.y-b.y)/k,rr=R/k;
    const keep=b.strokes.filter(st=>{const p=st.p,lim=rr+st.s/2;if(p.length===2)return Math.hypot(lx-p[0],ly-p[1])>lim;
      for(let i=0;i<p.length-2;i+=2)if(segDist(lx,ly,p[i],p[i+1],p[i+2],p[i+3])<=lim)return false;return true});
    if(keep.length===b.strokes.length)continue;
    W.stroke.changed=true;
    if(!keep.length){bl.splice(bi,1);nodeOf(b.id)?.remove();if(W.drawBlockId===b.id)W.drawBlockId=null;continue}
    const abs=absStrokes({...b,strokes:keep});rebaseDraw(b,abs);rerender(b);
  }
}

/* ---------- marquee selection & group actions ---------- */
function marqStart(e){
  board.setPointerCapture(e.pointerId);const base=e.shiftKey?new Set(W.multi):new Set();if(!e.shiftKey)select(null);
  const r=board.getBoundingClientRect(),box=el("div","marq");board.append(box);
  W.marq={id:e.pointerId,sx:e.clientX,sy:e.clientY,box,r,base};marqMove(e);
}
function marqMove(e){const M=W.marq;const x1=Math.min(M.sx,e.clientX)-M.r.left,y1=Math.min(M.sy,e.clientY)-M.r.top,w=Math.abs(e.clientX-M.sx),h=Math.abs(e.clientY-M.sy);
  Object.assign(M.box.style,{left:x1+"px",top:y1+"px",width:w+"px",height:h+"px"});M.ex={x1:e.clientX,y1:e.clientY}}
function marqCancel(){W.marq?.box.remove();W.marq=null}
function marqEnd(e){
  const M=W.marq;W.marq=null;M.box.remove();
  if(Math.abs(e.clientX-M.sx)+Math.abs(e.clientY-M.sy)<6){if(!M.base.size)select(null);return}
  const a=toCanvasF(Math.min(M.sx,e.clientX),Math.min(M.sy,e.clientY)),b2=toCanvasF(Math.max(M.sx,e.clientX),Math.max(M.sy,e.clientY));
  const ids=new Set(M.base);
  for(const b of day(S.open).blocks){if(b.hidden)continue;const n=nodeOf(b.id);if(!n)continue;
    const x=b.x,y=b.y,w=n.offsetWidth,h=n.offsetHeight;if(x<b2.x&&x+w>a.x&&y<b2.y&&y+h>a.y)ids.add(b.id)}
  selectMany(expandGroups([...ids]));
}
function updateSelBar(){
  let bar=$("selbar");
  if(!S.open||W.multi.size<2){bar&&bar.remove();return}
  if(!bar){bar=el("div","selbar");bar.id="selbar";board.append(bar);["pointerdown","dblclick","contextmenu"].forEach(ev=>bar.addEventListener(ev,e=>{e.stopPropagation();if(ev==="contextmenu")e.preventDefault()}))}
  bar.textContent="";bar.append(el("span",null,"Выбрано: "+W.multi.size));
  const act=el("button","btn","Действия");act.onclick=ev=>{const r=act.getBoundingClientRect();groupMenu(r.left,r.bottom+6)};
  const del=el("button","btn","Удалить");del.onclick=()=>removeMany([...W.multi]);
  const x=el("button","btn icon","✕");x.setAttribute("aria-label","Снять выделение");x.onclick=()=>select(null);
  bar.append(act,del,x);
}
function groupMenu(cx,cy){
  const sel=selBlocks();if(!sel.length)return;
  const allLocked=sel.every(b=>b.locked),hasNotes=sel.some(b=>b.type==="text"||b.type==="todo");
  const en=[{label:"Выбрано: "+sel.length,head:true}];
  en.push({swatches:true,cur:"-",pick:c=>setStyle(sel,{bg:c})},{ic:"◐",label:"Оформление…",run:()=>openStylePop(cx,cy,sel)},"-");
  const grouped=sel.length>1&&sel.every(b=>b.g&&b.g===sel[0].g);
  if(!grouped)en.push({ic:"▣",label:"Сгруппировать",run:groupSel});
  if(sel.some(b=>b.g))en.push({ic:"▢",label:"Разгруппировать",run:ungroupSel});
  en.push({ic:"⧉",label:"Дублировать",run:()=>{const ids=[],gm={};for(const b of sel){const c=JSON.parse(JSON.stringify(b));if(c.items)c.items.forEach(i=>i.id=uid());if(c.g)c.g=gm[c.g]||(gm[c.g]=uid());ids.push(addItem(c,{x:b.x+28,y:b.y+28}).id)}selectMany(ids)}},
    {ic:"⤒",label:"На передний план",run:()=>{for(const b of sel)reorder(b,1e9)}},
    {ic:"⤓",label:"На задний план",run:()=>{for(const b of [...sel].reverse())reorder(b,0)}},
    {ic:allLocked?"◌":"⊘",label:allLocked?"Разблокировать":"Заблокировать",run:()=>{for(const b of sel){b.locked=!allLocked;rerender(b)}paintSel();scheduleSave(S.open)}},
    "-",{ic:"✕",label:"Удалить",danger:true,run:()=>removeMany(sel.map(b=>b.id))});
  openMenu(cx,cy,en);
}

/* ---------- element style: fill, border, corners, shadow, opacity ---------- */
const FILLN={"":"Как в теме",y:"Жёлтый",o:"Оранжевый",r:"Красный",p:"Розовый",v:"Фиолетовый",b:"Голубой",t:"Бирюзовый",g:"Зелёный",k:"Графит",none:"Без фона"};
const QUICK_FILLS=["","y","o","r","p","v","b","t","g","k"];
const fillCss=f=>!f?"":f==="none"?"transparent":f[0]==="#"?f:"var(--n-"+f+")";
const LINE_COLORS=["","ink","accent","#e5484d","#f59e0b","#22a06b","#3b82f6","#8b5cf6","#ffffff"];
const LINEN={"":"Как в теме",ink:"Цвет текста",accent:"Акцент","#e5484d":"Красный","#f59e0b":"Оранжевый","#22a06b":"Зелёный","#3b82f6":"Синий","#8b5cf6":"Фиолетовый","#ffffff":"Белый"};
const lineCss=c=>!c?"":c==="ink"?"var(--ink)":c==="accent"?"var(--accent)":c;
const curFill=b=>(b.st&&b.st.bg!=null)?b.st.bg:(b.color||"");
function applyStyle(n,b){
  const st=b.st||{},f=curFill(b);
  if(f){n.style.setProperty("--it-bg",fillCss(f));const fg=f==="k"?"var(--n-kf)":f[0]==="#"?onColor(f):"";if(fg)n.style.setProperty("--it-fg",fg)}
  if(st.bw!=null)n.style.setProperty("--it-bw",st.bw+"px");
  if(st.bc)n.style.setProperty("--it-bc",lineCss(st.bc));
  if(st.bs)n.style.setProperty("--it-bs",st.bs);
  if(st.r!=null)n.style.setProperty("--it-r",st.r+"px");
  if(st.sh===0)n.classList.add("nosh");else if(st.sh===1)n.classList.add("sh");
  if(st.op!=null&&st.op<1)n.style.opacity=st.op;
}
function setStyle(list,patch,save=true){
  for(const b of list){const st={...(b.st||{})};
    for(const [k,v] of Object.entries(patch)){if(v===undefined||v===null||v==="")delete st[k];else st[k]=v}
    if("bg" in patch)delete b.color;
    if(Object.keys(st).length)b.st=st;else delete b.st;rerender(b)}
  paintSel();if(save){scheduleSave(S.open);histBoundary(S.open)}
}
function openStylePop(cx,cy,list){
  closePop();closeMenu();histBoundary(S.open);
  const p=el("div","pop stylepop");p.id="pop";p.setAttribute("role","dialog");p.setAttribute("aria-label","Оформление");document.body.append(p);
  ["pointerdown","dblclick","contextmenu"].forEach(ev=>p.addEventListener(ev,e=>e.stopPropagation()));
  const ref=list[0];
  const seg=(opts,cur,fn)=>{const s=el("div","seg sseg");opts.forEach(([l,v])=>{const b=el("button",cur===v?"on":"",l);b.type="button";b.onclick=()=>{fn(v);rnd()};s.append(b)});return s};
  const picker=(id,val,fn)=>{const i=el("input","cpick");i.type="color";i.id=id;i.value=/^#[0-9a-f]{6}$/i.test(val||"")?val:"#ffd166";i.title="Свой цвет";i.setAttribute("aria-label","Свой цвет");
    i.oninput=()=>fn(i.value,false);i.onchange=()=>{fn(i.value,true);rnd()};return i};
  const rnd=()=>{
    const st=ref.st||{},f=curFill(ref);const sc=p.scrollTop;p.textContent="";if(p.classList.contains("sheet"))p.append(el("div","grab"));setTimeout(()=>{p.scrollTop=sc},0);
    const h=el("div","sethead");h.append(el("b",null,"Оформление"+(list.length>1?" · "+list.length:"")));const x=el("button","mdel","✕");x.setAttribute("aria-label","Закрыть");x.onclick=closePop;h.append(x);p.append(h);
    p.append(el("div","mlabel","Фон"));
    const fr=el("div","swatches");
    [...QUICK_FILLS,"none"].forEach(c=>{const b=el("button",(f===c?"on":"")+(c==="none"?" chk":""));if(c!=="none")b.style.background=fillCss(c)||"var(--sheet)";b.title=FILLN[c];b.setAttribute("aria-label",FILLN[c]);b.onclick=()=>{setStyle(list,{bg:c});rnd()};fr.append(b)});
    fr.append(picker("bgPick",f,(v,save)=>setStyle(list,{bg:v},save)));p.append(fr);
    p.append(el("div","mlabel","Рамка"));
    p.append(seg([["Авто",null],["Нет",0],["Тонкая",1],["Средняя",2],["Толстая",4]],st.bw??null,v=>setStyle(list,{bw:v})));
    const br=el("div","swatches");
    LINE_COLORS.forEach(c=>{const b=el("button",((st.bc||"")===c?"on":"")+(c===""?" auto":""));if(c)b.style.background=lineCss(c);b.title=LINEN[c];b.setAttribute("aria-label","Рамка: "+LINEN[c]);
      b.onclick=()=>{const pt={bc:c};if(c&&(st.bw==null||st.bw===0))pt.bw=2;setStyle(list,pt);rnd()};br.append(b)});
    br.append(picker("bcPick",st.bc,(v,save)=>setStyle(list,{bc:v,...(st.bw==null||st.bw===0?{bw:2}:{})},save)));p.append(br);
    p.append(seg([["Сплошная",null],["Пунктир","dashed"],["Точки","dotted"],["Двойная","double"]],st.bs??null,v=>setStyle(list,{bs:v,...(v==="double"&&(st.bw??1)<3?{bw:4}:{})})));
    p.append(el("div","mlabel","Углы"));
    p.append(seg([["Авто",null],["Прямые",0],["Мягкие",8],["Круглые",20],["Капсула",60]],st.r??null,v=>setStyle(list,{r:v})));
    p.append(el("div","mlabel","Тень"));
    p.append(seg([["Авто",null],["Нет",0],["Есть",1]],st.sh??null,v=>setStyle(list,{sh:v})));
    const ol=el("label","slider oprow");const top=el("div");const ov=el("b",null,Math.round((st.op??1)*100)+"%");top.append(el("span",null,"Непрозрачность"),ov);
    const r=el("input");r.type="range";r.min=20;r.max=100;r.id="opRange";r.value=Math.round((st.op??1)*100);
    r.oninput=()=>{ov.textContent=r.value+"%";setStyle(list,{op:+r.value>=100?null:+r.value/100},false)};r.onchange=()=>{scheduleSave(S.open);histBoundary(S.open)};
    ol.append(top,r);p.append(ol);
    const rs=el("div","row");const rb=el("button","btn","Сбросить оформление");rb.onclick=()=>{setStyle(list,{bg:"",bw:null,bc:null,bs:null,r:null,sh:null,op:null});rnd()};rs.append(rb);p.append(rs);
    if(p.classList.contains("sheet")||sheetify(p))return;
    const pr=p.getBoundingClientRect();p.style.left=Math.max(8,Math.min(cx,innerWidth-pr.width-8))+"px";p.style.top=Math.max(8,Math.min(cy,VV().h-pr.height-8))+"px";
  };
  rnd();
}

/* ---------- groups ---------- */
function groupOf(b){return b&&b.g?(S.days[S.open]?.blocks||[]).filter(x=>x.g===b.g):[b]}
function expandGroups(ids){const gs=new Set(ids.map(id=>findB(id)?.g).filter(Boolean));if(!gs.size)return ids;const set=new Set(ids);
  for(const b of day(S.open).blocks)if(b.g&&gs.has(b.g)&&!b.hidden)set.add(b.id);return [...set]}
function groupSel(){const sel=selBlocks();if(sel.length<2){toast("Выделите два элемента или больше");return}
  histBoundary(S.open);const g=uid();for(const b of sel){b.g=g;nodeOf(b.id)?.classList.add("grp")}
  renderLayers();paintSel();scheduleSave(S.open);histBoundary(S.open);toast("Сгруппировано: "+sel.length+". Теперь они двигаются вместе")}
function ungroupSel(){const sel=selBlocks().filter(b=>b.g);if(!sel.length)return;
  histBoundary(S.open);for(const b of sel){delete b.g;nodeOf(b.id)?.classList.remove("grp")}
  renderLayers();paintSel();scheduleSave(S.open);histBoundary(S.open);toast("Группа разобрана")}
function updateGroupFrame(){
  let f=$("gframe");const sel=S.open?selBlocks().filter(b=>!b.hidden):[];
  if(sel.length<2){f&&f.remove();return}
  if(!f){f=el("div","gframe");f.id="gframe";f.append(el("span","glbl"));plane.append(f)}
  let x1=1e9,y1=1e9,x2=-1e9,y2=-1e9;
  for(const b of sel){const n=nodeOf(b.id);if(!n)continue;x1=Math.min(x1,b.x);y1=Math.min(y1,b.y);x2=Math.max(x2,b.x+n.offsetWidth);y2=Math.max(y2,b.y+n.offsetHeight)}
  const pad=10;Object.assign(f.style,{left:(x1-pad)+"px",top:(y1-pad)+"px",width:(x2-x1+2*pad)+"px",height:(y2-y1+2*pad)+"px"});
  const grouped=sel.every(b=>b.g&&b.g===sel[0].g);f.classList.toggle("is-group",grouped);f.firstChild.textContent=grouped?"Группа":"Выбрано: "+sel.length;
}

/* ---------- iPad / touch: two-finger tap = undo, three-finger tap = redo ---------- */
const TT={pts:new Map(),max:0,start:0,moved:false};
board.addEventListener("pointerdown",e=>{if(e.pointerType!=="touch")return;if(!TT.pts.size){TT.max=0;TT.start=Date.now();TT.moved=false}
  TT.pts.set(e.pointerId,{x:e.clientX,y:e.clientY});TT.max=Math.max(TT.max,TT.pts.size)},true);
board.addEventListener("pointermove",e=>{const p0=TT.pts.get(e.pointerId);if(p0&&Math.hypot(e.clientX-p0.x,e.clientY-p0.y)>12)TT.moved=true},true);
const ttEnd=e=>{if(!TT.pts.has(e.pointerId))return;TT.pts.delete(e.pointerId);if(TT.pts.size)return;
  if(e.type==="pointerup"&&!TT.moved&&TT.max>=2&&Date.now()-TT.start<400&&S.open&&!$("modal")){if(W.stroke)drawCancel();undoRedo(TT.max===2?-1:1)}};
board.addEventListener("pointerup",ttEnd,true);board.addEventListener("pointercancel",ttEnd,true);

/* ---------- generic modal ---------- */
function openModal(cls,label){closeModal();closeMenu();closePop();const o=el("div","modal");o.id="modal";const box=el("div","mbox "+cls);box.setAttribute("role","dialog");box.setAttribute("aria-label",label);
  o.append(box);o.addEventListener("pointerdown",e=>{if(e.target===o)closeModal()});document.body.append(o);return box}
function closeModal(){const m=$("modal");if(m){m.remove();if(m._onclose)m._onclose()}}
function ask(title,placeholder,okLabel,value=""){
  return new Promise(res=>{const box=openModal("askbox",title);$("modal")._onclose=()=>res(null);
    const f=el("form","pwf");f.append(el("h3","mtitle",title));const i=el("input","inp");i.id="askIn";i.placeholder=placeholder;i.value=value;i.maxLength=60;
    const r=el("div","row"),ok=el("button","btn primary",okLabel);ok.type="submit";const c=el("button","btn","Отмена");c.type="button";c.onclick=()=>closeModal();r.append(ok,c);f.append(i,r);box.append(f);
    f.onsubmit=e=>{e.preventDefault();const v=i.value.trim();if(!v){i.focus();return}$("modal")._onclose=null;closeModal();res(v)};setTimeout(()=>i.focus(),30)});
}

/* ---------- search ---------- */
const nrm=s=>(s||"").toLowerCase().replace(/ё/g,"е");
const fmtDay=k=>{const d=parse(k);return d.getDate()+" "+MG[d.getMonth()]+" "+d.getFullYear()+" · "+WD[d.getDay()]};
function openSearch(){
  if(document.body.classList.contains("locked"))return;
  closeSettings();closeBackup();closeTasks();
  const box=openModal("srch","Поиск");
  const top=el("div","srchtop");const q=el("input","inp srchin");q.id="q";q.type="search";q.placeholder="Поиск по всем дням";q.autocomplete="off";q.setAttribute("aria-label","Поиск по всем дням");
  const x=el("button","btn icon","✕");x.setAttribute("aria-label","Закрыть поиск");x.onclick=closeModal;top.append(q,x);
  const info=el("div","srchinfo"),list=el("div","srchres");box.append(top,info,list);
  let res=[],cur=0,t=null;
  const draw=()=>{list.textContent="";
    if(!q.value.trim()){info.textContent="Ищет в названиях дней, заметках, задачах, подписях и именах файлов.";return}
    info.textContent=res.length?"Найдено: "+res.length+(res.length>=200?"+":""):"Ничего не найдено";
    let lastK=null;res.forEach((r,i)=>{if(r.k!==lastK){list.append(el("div","srchday",fmtDay(r.k)));lastK=r.k}
      const b=el("button","srchrow"+(i===cur?" on":""));b.append(el("span","srchic",r.ic));const tx=el("span","srchtx");hl(tx,r.text,q.value.trim());b.append(tx);
      b.onclick=()=>openResult(r);b.onmouseenter=()=>{cur=i;list.querySelectorAll(".srchrow").forEach((n,j)=>n.classList.toggle("on",j===cur))};list.append(b)})};
  q.oninput=()=>{clearTimeout(t);t=setTimeout(()=>{res=runSearch(q.value.trim());cur=0;draw()},120)};
  q.onkeydown=e=>{if(e.key==="ArrowDown"||e.key==="ArrowUp"){e.preventDefault();if(!res.length)return;cur=(cur+(e.key==="ArrowDown"?1:-1)+res.length)%res.length;draw();list.querySelector(".on")?.scrollIntoView({block:"nearest"})}
    if(e.key==="Enter"&&res[cur]){e.preventDefault();openResult(res[cur])}};
  draw();setTimeout(()=>q.focus(),30);
}
function snippet(text,qi){const i=nrm(text).indexOf(qi);const a=Math.max(0,i-40),b=Math.min(text.length,i+qi.length+70);return (a>0?"…":"")+text.slice(a,b).replace(/\s+/g," ")+(b<text.length?"…":"")}
function hl(node,text,q){const nq=nrm(q),nt=nrm(text);let p=0,i;while(nq&&(i=nt.indexOf(nq,p))>=0){node.append(text.slice(p,i));node.append(el("mark",null,text.slice(i,i+nq.length)));p=i+nq.length}node.append(text.slice(p))}
function runSearch(q){
  const nq=nrm(q);if(!nq)return [];const out=[];
  const add=(k,ic,text,bid)=>{if(nrm(text).includes(nq))out.push({k,ic,text:snippet(text,nq),bid})};
  for(const k of Object.keys(S.days).sort().reverse()){const d=S.days[k];if(!d)continue;
    if(d.title)add(k,"#",d.title,null);
    for(const b of d.blocks||[]){
      if(b.type==="text")add(k,"¶",b.text||"",b.id);
      else if(b.type==="todo")for(const it of b.items||[])add(k,it.done?"☑":"☐",it.text||"",b.id);
      else if(b.type==="image")add(k,"▣",[b.caption,b.name].filter(Boolean).join(" · "),b.id);
      else if(b.type==="file"||b.type==="audio")add(k,b.type==="audio"?"♪":"⎙",b.name||"",b.id);
    }
    if(out.length>=200)break;
  }
  return out;
}
function openResult(r){closeModal();openDay(r.k);if(!r.bid)return;const b=findB(r.bid);if(!b)return;
  if(b.hidden){b.hidden=false;rerender(b);scheduleSave(r.k)}select(b.id);reveal(b,true);flash(b.id)}
function flash(id){const n=nodeOf(id);if(!n)return;n.classList.remove("flash");void n.offsetWidth;n.classList.add("flash");setTimeout(()=>n.classList.remove("flash"),1600)}
$("srchOpen").onclick=openSearch;$("srchOpen2").onclick=openSearch;

/* ---------- unfinished tasks ---------- */
function estH(b){if(b.type==="text")return 70+((b.text||"").split("\n").length)*24;if(b.type==="todo")return 64+(b.items||[]).length*34;
  if(b.type==="image")return b.w*.75+40;if(b.type==="draw")return b.w*b.vh/b.vw;if(b.type==="sticker")return b.w;return 90}
function freeSpot(d){const bl=(d.blocks||[]).filter(b=>!b.hidden);if(!bl.length)return {x:40,y:40};return {x:Math.min(...bl.map(b=>b.x)),y:Math.max(...bl.map(b=>b.y+estH(b)))+40}}
function carryTo(toK,pairs){ // pairs: [{k,b,it}]
  if(!pairs.length)return 0;const to=day(toK);
  let tb=(to.blocks||[]).find(x=>x.type==="todo"&&x.label==="Перенесено");
  if(!tb){tb={id:uid(),type:"todo",label:"Перенесено",w:280,items:[],...freeSpot(to)};to.blocks.push(tb)}
  const touched=new Set([toK]);
  for(const {k,b,it} of pairs){const j=b.items.indexOf(it);if(j<0)continue;b.items.splice(j,1);tb.items.push({id:uid(),text:it.text,done:false,from:k});touched.add(k);
    if(!b.items.length){const bl=S.days[k].blocks,bi=bl.indexOf(b);if(bi>=0)bl.splice(bi,1)}}
  for(const k of touched)scheduleSave(k);
  if(S.open&&touched.has(S.open)){renderWs();histTouch(S.open)}
  return pairs.length;
}
function carryBlockToTomorrow(b){
  const from=S.open,d=parse(from);d.setDate(d.getDate()+1);const to=key(d);
  const n=carryTo(to,(b.items||[]).filter(i=>!i.done&&i.text.trim()).map(it=>({k:from,b,it})));
  toast("Перенесено на "+d.getDate()+" "+MG[d.getMonth()]+": "+n,["Открыть",()=>{hideToast();openDay(to)}],5000);
}
function openTasks(){closeSettings();closeBackup();closeModal();if($("tasks")){closeTasks();return}
  const p=el("aside","set");p.id="tasks";p.setAttribute("role","dialog");p.setAttribute("aria-label","Незавершённые задачи");document.body.append(p);renderTasks()}
function closeTasks(){$("tasks")?.remove()}
function allOpenTasks(){const out=[];for(const k of Object.keys(S.days).sort()){for(const b of S.days[k].blocks||[])if(b.type==="todo")for(const it of b.items||[])if(!it.done&&it.text.trim())out.push({k,b,it})}return out}
function renderTasks(){
  const p=$("tasks");if(!p)return;const st=p.scrollTop;p.textContent="";
  const h=el("div","sethead");h.append(el("h2",null,"Задачи"));const x=el("button","btn icon","✕");x.setAttribute("aria-label","Закрыть");x.onclick=closeTasks;h.append(x);p.append(h);
  const tk=key(new Date()),all=allOpenTasks(),over=all.filter(t=>t.k<tk);
  if(!all.length){p.append(el("p","bkintro","Незавершённых задач нет."));return}
  if(over.length){const r=el("div","row");const b=el("button","btn primary","Перенести просроченные на сегодня ("+over.length+")");
    b.onclick=()=>{const n=carryTo(tk,over);toast("Перенесено на сегодня: "+n);renderTasks()};r.append(b);p.append(r)}
  const groups=[["Просрочено",all.filter(t=>t.k<tk)],["Сегодня",all.filter(t=>t.k===tk)],["Впереди",all.filter(t=>t.k>tk)]];
  for(const [title,list] of groups){if(!list.length)continue;const s=el("section","sec");s.append(el("h3",null,title+" · "+list.length));let lastK=null;
    for(const t of title==="Просрочено"?[...list].reverse():list){
      if(t.k!==lastK&&title!=="Сегодня"){s.append(el("div","tday",fmtDay(t.k)));lastK=t.k}
      const r=el("div","trow");const c=el("input");c.type="checkbox";c.id="tk-"+t.it.id;c.setAttribute("aria-label","Готово");
      c.onchange=()=>{t.it.done=c.checked;r.classList.toggle("done",c.checked);scheduleSave(t.k);if(S.open===t.k){const n=nodeOf(t.b.id);if(n)rerender(t.b)}};
      const tx=el("label","ttx",t.it.text);tx.htmlFor=c.id;
      const go=el("button","btn icon","→");go.setAttribute("aria-label","Открыть день");go.title="Открыть день";
      go.onclick=()=>{closeTasks();openDay(t.k);const b=findB(t.b.id);if(b){select(b.id);reveal(b,true);flash(b.id)}};
      r.append(c,tx,go);s.append(r)}
    p.append(s)}
  p.scrollTop=st;
}
$("tasksOpen").onclick=openTasks;
document.addEventListener("pointerdown",e=>{const p=$("tasks");if(p&&!p.contains(e.target)&&!e.target.closest("#tasksOpen,.toast"))closeTasks()},true);

/* ---------- templates ---------- */
const TPL=[
  {id:"plan",n:"План дня",blocks:[{type:"todo",x:0,y:0,w:300,label:"Главное",items:["","",""]},{type:"todo",x:330,y:0,w:280,label:"Дела",items:[""]},{type:"text",x:0,y:210,w:300,color:"y",text:"Заметки\n"}]},
  {id:"diary",n:"Дневник",blocks:[{type:"text",x:0,y:0,w:300,color:"y",text:"Что было хорошего сегодня:\n"},{type:"text",x:330,y:0,w:300,color:"b",text:"Чему я научился:\n"},{type:"text",x:0,y:170,w:300,color:"g",text:"За что я благодарен:\n"},{type:"text",x:330,y:170,w:300,color:"p",text:"Что завтра сделаю иначе:\n"}]},
  {id:"retro",n:"Ретро недели",blocks:[{type:"text",x:0,y:0,w:260,color:"g",text:"Что получилось\n"},{type:"text",x:290,y:0,w:260,color:"p",text:"Что мешало\n"},{type:"text",x:580,y:0,w:260,color:"b",text:"Что изменить\n"},{type:"todo",x:0,y:180,w:300,label:"Действия",items:[""]}]},
  {id:"meet",n:"Встреча",blocks:[{type:"text",x:0,y:0,w:300,text:"Повестка:\n1. \n2. \n3. "},{type:"text",x:330,y:0,w:240,color:"b",text:"Участники:\n"},{type:"todo",x:0,y:190,w:300,label:"Решения и задачи",items:[""]}]}
];
function templateMenu(cx,cy,pos){
  const en=[{label:"Шаблоны",head:true},...TPL.map(t=>({ic:"▤",label:t.n,run:()=>applyTemplate(t,pos)}))];
  if(S.templates.length){en.push("-",{label:"Мои шаблоны",head:true});S.templates.forEach(t=>en.push({ic:"★",label:t.n,run:()=>applyTemplate(t,pos),del:()=>deleteTemplate(t.id)}))}
  en.push("-",{ic:"+",label:"Сохранить этот день как шаблон…",run:saveTemplate});
  openMenu(cx,cy,en);
}
function applyTemplate(t,pos){
  const ids=[];
  const gm={};
  for(const tb of t.blocks){const b=JSON.parse(JSON.stringify(tb));delete b.id;if(b.g)b.g=gm[b.g]||(gm[b.g]=uid());
    if(b.type==="todo")b.items=(b.items||[]).map(it=>typeof it==="string"?{id:uid(),text:it,done:false}:{id:uid(),text:it.text||"",done:false});
    ids.push(addItem(b,{x:pos.x+tb.x,y:pos.y+tb.y}).id)}
  selectMany(ids);
}
async function saveTemplate(){
  const bl=(day(S.open).blocks||[]).filter(b=>!b.hidden&&(b.type==="text"||b.type==="todo"||b.type==="draw"||(b.type==="sticker"&&b.emoji)));
  if(!bl.length){toast("В шаблон попадают заметки, задачи, рисунки и эмодзи-стикеры — на этом холсте их нет");return}
  const name=await ask("Название шаблона","Например, «Утренние страницы»","Сохранить",day(S.open).title||"");if(!name)return;
  const x0=Math.min(...bl.map(b=>b.x)),y0=Math.min(...bl.map(b=>b.y));
  const blocks=bl.map(b=>{const c=stripB(b);delete c.id;delete c.locked;delete c.hidden;c.x-=x0;c.y-=y0;if(c.items)c.items=c.items.map(i=>i.text);return c});
  S.templates=[...S.templates,{id:uid(),n:name,blocks}];await store.put("kv","templates",S.templates);toast("Шаблон «"+name+"» сохранён")
}
async function deleteTemplate(id){const t=S.templates.find(x=>x.id===id);S.templates=S.templates.filter(x=>x.id!==id);await store.put("kv","templates",S.templates);
  toast("Шаблон удалён",["Вернуть",async()=>{hideToast();S.templates=[...S.templates,t];await store.put("kv","templates",S.templates)}])}

/* ---------- mood, day colour, habits ---------- */
const MOODS=[{e:"😞",n:"Плохо"},{e:"😕",n:"Так себе"},{e:"😐",n:"Нормально"},{e:"🙂",n:"Хорошо"},{e:"😄",n:"Отлично"}];
const TAGS={red:"#e5484d",orange:"#f59e0b",yellow:"#eab308",green:"#22a06b",blue:"#3b82f6",purple:"#8b5cf6"};
const TAGN={red:"Красный",orange:"Оранжевый",yellow:"Жёлтый",green:"Зелёный",blue:"Синий",purple:"Фиолетовый"};
const HCOL=["#3b82f6","#22a06b","#f59e0b","#e5484d","#8b5cf6","#0ea5a4","#db2777","#64748b"];
const habitColor=h=>HCOL[S.habits.indexOf(h)%HCOL.length];
function habitDots(d){if(!d||!d.habits)return null;const on=S.habits.filter(h=>d.habits[h.id]);if(!on.length)return null;
  const w=el("span","hdots");on.slice(0,6).forEach(h=>{const i=el("i");i.style.background=habitColor(h);i.title=h.n;w.append(i)});return w}
function streak(id,k){let n=0;const d=parse(k);for(;;){const v=S.days[key(d)];if(v&&v.habits&&v.habits[id]){n++;d.setDate(d.getDate()-1)}else break}return n}
function renderDayChip(){const b=$("dayBtn");if(!b||!S.open)return;const d=S.days[S.open]||{};b.textContent="";
  b.append(el("span","dmood",d.mood?MOODS[d.mood-1].e:"☺"));if(d.tag&&TAGS[d.tag]){const t=el("i","dtag");t.style.background=TAGS[d.tag];b.append(t)}
  const n=d.habits?S.habits.filter(h=>d.habits[h.id]).length:0;if(n)b.append(el("span","dhab",n+"/"+S.habits.length));
  b.classList.toggle("marked",!!(d.mood||d.tag||n))}
function closePop(){$("pop")?.remove();dropSheetBg()}
function openPop(){
  if($("pop")){closePop();return}closeMenu();
  const k=S.open,p=el("div","pop");p.id="pop";p.setAttribute("role","dialog");p.setAttribute("aria-label","Отметки дня");document.body.append(p);
  const rnd=()=>{const d=S.days[k]||{};const sc=p.scrollTop;p.textContent="";if(p.classList.contains("sheet"))p.append(el("div","grab"));setTimeout(()=>{p.scrollTop=sc},0);
    p.append(el("div","mlabel","Настроение"));const mr=el("div","moods");
    MOODS.forEach((m,i)=>{const b=el("button",d.mood===i+1?"on":"",m.e);b.title=m.n;b.setAttribute("aria-label",m.n);b.onclick=()=>{const dd=day(k);dd.mood=dd.mood===i+1?0:i+1;if(!dd.mood)delete dd.mood;scheduleSave(k);renderDayChip();rnd()};mr.append(b)});p.append(mr);
    p.append(el("div","mlabel","Цвет дня"));const tr=el("div","swatches");
    const none=el("button",!d.tag?"on":"");none.style.background="var(--sheet)";none.setAttribute("aria-label","Без цвета");none.title="Без цвета";none.onclick=()=>{const dd=day(k);delete dd.tag;scheduleSave(k);renderDayChip();rnd()};tr.append(none);
    Object.entries(TAGS).forEach(([t,c])=>{const b=el("button",d.tag===t?"on":"");b.style.background=c;b.setAttribute("aria-label",TAGN[t]);b.title=TAGN[t];b.onclick=()=>{const dd=day(k);dd.tag=t;scheduleSave(k);renderDayChip();rnd()};tr.append(b)});p.append(tr);
    p.append(el("div","mlabel","Привычки"));
    if(!S.habits.length)p.append(el("p","bknote hpad","Отмечайте, что сделали сегодня: спорт, сон, чтение. Отметки видны в календаре точками."));
    S.habits.forEach(h=>{const r=el("div","hrow");const c=el("input");c.type="checkbox";c.id="h-"+h.id;c.checked=!!(d.habits&&d.habits[h.id]);c.style.accentColor=habitColor(h);
      c.onchange=()=>{const dd=day(k);dd.habits={...(dd.habits||{})};if(c.checked)dd.habits[h.id]=1;else delete dd.habits[h.id];if(!Object.keys(dd.habits).length)delete dd.habits;scheduleSave(k);renderDayChip();rnd()};
      const l=el("label",null,h.n);l.htmlFor=c.id;const sk=streak(h.id,k);const s2=el("span","hstreak",sk>1?"серия "+sk:"");
      const x=el("button","mdel","✕");x.setAttribute("aria-label","Удалить привычку «"+h.n+"»");
      x.onclick=()=>{if(x.dataset.c){S.habits=S.habits.filter(z=>z.id!==h.id);store.put("kv","habits",S.habits);renderCal();renderDayChip();rnd()}else{x.dataset.c=1;x.textContent="Удалить?";x.classList.add("confirm")}};
      r.append(c,l,s2,x);p.append(r)});
    const f=el("form","hadd");const i=el("input","inp");i.id="habitNew";i.placeholder="Новая привычка";i.maxLength=40;const ab=el("button","btn","Добавить");ab.type="submit";f.append(i,ab);
    f.onsubmit=e=>{e.preventDefault();const v=i.value.trim();if(!v)return;S.habits=[...S.habits,{id:uid(),n:v}];store.put("kv","habits",S.habits);rnd();setTimeout(()=>$("habitNew")?.focus(),0)};p.append(f);
    if(p.classList.contains("sheet")||sheetify(p))return;
    const r=$("dayBtn").getBoundingClientRect(),pr=p.getBoundingClientRect();p.style.top=(r.bottom+6)+"px";p.style.left=Math.max(8,Math.min(r.left,innerWidth-pr.width-8))+"px";
  };rnd();
}
$("dayBtn").onclick=e=>{e.stopPropagation();openPop()};
document.addEventListener("pointerdown",e=>{const p=$("pop");if(p&&!p.contains(e.target)&&!e.target.closest("#dayBtn"))closePop()},true);

/* ---------- "on this day" ---------- */
function renderMemo(){
  const m=$("memo");if(!m)return;const t=new Date(),tk=key(t);let hidden="";try{hidden=localStorage.getItem("tetrad-memo-hidden")||""}catch(e){}
  const items=[];
  const peek=d=>(d.title||"").trim()||((d.blocks||[]).find(b=>b.type==="text"&&(b.text||"").trim())?.text||"").split("\n")[0]||((d.blocks||[]).length+" "+plural((d.blocks||[]).length,"элемент","элемента","элементов"));
  const mo=new Date(t);mo.setMonth(mo.getMonth()-1);if(mo.getDate()===t.getDate()){const k=key(mo);if(S.days[k]&&!isEmpty(S.days[k]))items.push({k,l:"Месяц назад"})}
  for(let y=1;y<=10;y++){const d=new Date(t.getFullYear()-y,t.getMonth(),t.getDate());if(d.getMonth()!==t.getMonth())continue;const k=key(d);
    if(S.days[k]&&!isEmpty(S.days[k]))items.push({k,l:y===1?"Год назад":y+" "+plural(y,"год","года","лет")+" назад"})}
  if(!items.length||hidden===tk){m.hidden=true;return}
  m.hidden=false;m.textContent="";m.append(el("b",null,"В этот день"));
  items.slice(0,3).forEach(it=>{const b=el("button","memoit");b.append(el("span","ml",it.l),el("span","mt",peek(S.days[it.k])));b.onclick=()=>openDay(it.k);m.append(b)});
  const x=el("button","btn icon","✕");x.setAttribute("aria-label","Скрыть до завтра");x.onclick=()=>{try{localStorage.setItem("tetrad-memo-hidden",tk)}catch(e){}m.hidden=true};m.append(x);
}

/* ---------- stickers ---------- */
const EMOJI_STICKERS=["😀","😂","🥰","😎","🤔","😴","🥳","😭","👍","👏","🙏","💪","❤️","🔥","✨","⭐","🎉","🎯","✅","❌","💡","📌","📚","☕","🍕","🌸","🌈","☀️","🌙","⚡","🎵","🚀"];
function openStickers(pos){
  W.stickPos=pos||centerPos();
  const box=openModal("stsheet","Стикеры");
  const h=el("div","sethead");h.append(el("h3","mtitle","Стикеры"));const x=el("button","btn icon","✕");x.setAttribute("aria-label","Закрыть");x.onclick=closeModal;h.append(x);box.append(h);
  const zone=el("div","stickzone");zone.contentEditable="true";zone.id="stickZone";zone.setAttribute("role","textbox");zone.setAttribute("aria-label","Поле для стикера");
  zone.dataset.ph=IOS?"Нажмите сюда, откройте клавиатуру эмодзи и выберите стикер. Или вставьте скопированный стикер или объект, вырезанный из «Фото»."
    :/Mac/.test(navigator.platform)?"Нажмите сюда и откройте «Эмодзи и символы» (Fn или 🌐 + E, либо Ctrl + Cmd + Пробел) — там есть ваши стикеры. Или вставьте скопированную картинку."
    :"Вставьте сюда скопированный стикер или картинку с прозрачным фоном (Ctrl + V).";
  box.append(zone);
  const take=files=>{const f=[...files].filter(x=>/^image\//.test(x.type)||/\.(heic|heif)$/i.test(x.name||""));if(!f.length)return false;closeModal();handleFiles(f,W.stickPos,{sticker:true});return true};
  zone.addEventListener("paste",e=>{const fs=e.clipboardData&&e.clipboardData.files;if(fs&&fs.length&&take(fs))e.preventDefault()});
  zone.addEventListener("beforeinput",e=>{const fs=e.dataTransfer&&e.dataTransfer.files;if(fs&&fs.length&&take(fs))e.preventDefault()});
  zone.addEventListener("input",()=>setTimeout(()=>scanZone(zone),30));
  zone.addEventListener("drop",e=>{const fs=e.dataTransfer&&e.dataTransfer.files;if(fs&&fs.length&&take(fs)){e.preventDefault();e.stopPropagation()}});
  const r=el("div","row");const fb=el("button","btn","Из фото или файла…");fb.onclick=()=>$("stickIn").click();r.append(fb);box.append(r);
  box.append(el("div","mlabel","Эмодзи"));const g=el("div","emogrid");
  EMOJI_STICKERS.forEach(e=>{const b=el("button",null,e);b.setAttribute("aria-label","Стикер "+e);b.onclick=()=>{closeModal();addItem({type:"sticker",emoji:e,w:120},W.stickPos)};g.append(b)});box.append(g);
  if(!COARSE)setTimeout(()=>zone.focus(),30);
}
const closeStickers=()=>{if($("modal")?.querySelector(".stsheet"))closeModal()};
async function scanZone(zone){
  const imgs=[...zone.querySelectorAll("img")];
  if(imgs.length){const files=[];for(const im of imgs){const b=await imgToBlob(im);if(b)files.push(new File([b],"стикер-"+Date.now()+"."+(b.type.split("/")[1]||"png"),{type:b.type||"image/png"}))}
    zone.textContent="";if(files.length){closeModal();handleFiles(files,W.stickPos,{sticker:true})}else toast("Не получилось вставить этот стикер. Попробуйте скопировать его и вставить сюда");return}
  const txt=(zone.textContent||"").trim();if(!txt)return;
  const first=window.Intl&&Intl.Segmenter?[...new Intl.Segmenter(undefined,{granularity:"grapheme"}).segment(txt)][0].segment:[...txt][0];
  zone.textContent="";
  if(/\p{Extended_Pictographic}/u.test(first)){closeModal();addItem({type:"sticker",emoji:first,w:120},W.stickPos)}
}
async function imgToBlob(im){
  const s=im.getAttribute("src")||"";
  if(/^(blob:|data:)/.test(s)){try{return await (await fetch(s)).blob()}catch(e){}}
  try{await im.decode();const c=document.createElement("canvas");c.width=im.naturalWidth;c.height=im.naturalHeight;c.getContext("2d").drawImage(im,0,0);
    return await new Promise(r=>c.toBlob(r,"image/png"))}catch(e){return null}
}
async function decodeBitmap(f){try{return await createImageBitmap(f)}catch(e){}
  try{const u=URL.createObjectURL(f);const im=new Image();im.src=u;await im.decode();URL.revokeObjectURL(u);return im}catch(e){return null}}
function alphaOf(bmp){try{const c=document.createElement("canvas");c.width=c.height=32;const x=c.getContext("2d",{willReadFrequently:true});x.drawImage(bmp,0,0,32,32);
  const d=x.getImageData(0,0,32,32).data;for(let i=3;i<d.length;i+=4)if(d[i]<250)return true}catch(e){}return false}
async function hasAlpha(f){if(!/png|webp|gif|heic|heif|avif/.test(f.type))return false;const b=await decodeBitmap(f);return b?alphaOf(b):false}
// HEIC/HEIF → PNG (с прозрачностью) или JPEG, где браузер умеет их читать; стикеры ужимаются до 1024 px.
async function normalizeImage(f,sticker){
  const heic=/heic|heif/i.test(f.type)||/\.(heic|heif)$/i.test(f.name||"");
  if(!heic&&!sticker)return f;
  const bmp=await decodeBitmap(f);if(!bmp)return f;
  const W0=bmp.width||bmp.naturalWidth,H0=bmp.height||bmp.naturalHeight,k=sticker?Math.min(1,1024/Math.max(W0,H0)):1;
  if(!heic&&k===1)return f;
  const c=document.createElement("canvas");c.width=Math.round(W0*k);c.height=Math.round(H0*k);c.getContext("2d").drawImage(bmp,0,0,c.width,c.height);
  const alpha=sticker||alphaOf(bmp),type=alpha?"image/png":"image/jpeg";
  const blob=await new Promise(r=>c.toBlob(r,type,.9));if(!blob)return f;
  return new File([blob],(f.name||"картинка").replace(/\.[^.]+$/,"")+(alpha?".png":".jpg"),{type});
}

/* ---------- voice notes ---------- */
let REC=null;
async function startRec(pos){
  if(REC)return;
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia||!window.MediaRecorder){toast("Запись голоса не поддерживается этим браузером");return}
  let stream;try{stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true}})}
  catch(e){toast(e&&e.name==="NotAllowedError"?"Нет доступа к микрофону. Разрешите его для этого сайта в настройках браузера":"Не удалось включить микрофон");return}
  const mt=["audio/mp4","audio/webm;codecs=opus","audio/webm","audio/ogg;codecs=opus"].find(t=>MediaRecorder.isTypeSupported&&MediaRecorder.isTypeSupported(t))||"";
  let mr;try{mr=new MediaRecorder(stream,mt?{mimeType:mt}:undefined)}catch(e){stream.getTracks().forEach(t=>t.stop());toast("Не удалось начать запись");return}
  const chunks=[];REC={mr,stream,chunks,pos:pos||centerPos(),k:S.open,start:Date.now(),cancel:false};
  mr.ondataavailable=e=>{if(e.data&&e.data.size)chunks.push(e.data)};
  mr.onstop=()=>{const r=REC;REC=null;stream.getTracks().forEach(t=>t.stop());clearInterval(r.timer);$("recbar")?.remove();
    if(r.cancel||!chunks.length)return;
    const type=(mr.mimeType||mt||"audio/webm").split(";")[0],ext=type.includes("mp4")?"m4a":type.includes("ogg")?"ogg":"webm",d=new Date();
    const f=new File(chunks,"Голос "+pad(d.getDate())+"."+pad(d.getMonth()+1)+" "+pad(d.getHours())+"-"+pad(d.getMinutes())+"."+ext,{type});
    if(S.open===r.k)handleFiles([f],r.pos)};
  mr.start(1000);
  const bar=el("div","recbar");bar.id="recbar";bar.setAttribute("role","status");const dot=el("i","recdot"),tm=el("span","rectm","0:00");
  const ok=el("button","btn primary","Сохранить"),no=el("button","btn","Отмена");ok.onclick=()=>stopRec(false);no.onclick=()=>stopRec(true);
  bar.append(dot,el("span",null,"Запись"),tm,ok,no);document.body.append(bar);
  REC.timer=setInterval(()=>{const s=Math.floor((Date.now()-REC.start)/1000);tm.textContent=Math.floor(s/60)+":"+pad(s%60);if(s>=3600)stopRec(false)},500);
}
function stopRec(cancel){if(!REC)return;REC.cancel=cancel;try{REC.mr.stop()}catch(e){REC.stream.getTracks().forEach(t=>t.stop());$("recbar")?.remove();REC=null}}

/* ---------- app lock ---------- */
const LOCK={on:false,autoLock:5,kind:"pin",bio:false,bioAvail:null,busy:false,err:"",form:null,progress:0};
async function refreshLock(){const r=await vault.record();LOCK.on=!!r;LOCK.autoLock=r?r.autoLock??5:5;LOCK.kind=r?r.kind:"pin";LOCK.bio=!!(r&&r.bio);
  if(LOCK.bioAvail===null)LOCK.bioAvail=await vault.bioAvailable();$("lockNow").hidden=!LOCK.on}
let lockFails=0,lockWait=0;
async function showLock(){
  document.body.classList.add("locked");$("lock").hidden=false;const i=$("lockIn");i.value="";
  i.inputMode=LOCK.kind==="pin"?"numeric":"text";i.setAttribute("aria-label",LOCK.kind==="pin"?"PIN-код":"Пароль");
  $("lockMsg").textContent=LOCK.kind==="pin"?"Введите PIN-код":"Введите пароль";$("lockBio").hidden=!LOCK.bio;$("lockErr").textContent="";$("lockReset").hidden=true;
  if(!COARSE||!LOCK.bio)setTimeout(()=>i.focus(),50);
}
async function afterUnlock(){lockFails=0;$("lock").hidden=true;document.body.classList.remove("locked");$("lockIn").value="";await startApp()}
$("lockForm").onsubmit=async e=>{e.preventDefault();const i=$("lockIn"),err=$("lockErr");
  if(Date.now()<lockWait){err.textContent="Подождите "+Math.ceil((lockWait-Date.now())/1000)+" с";return}
  if(!i.value)return;$("lockGo").disabled=true;$("lockGo").textContent="Проверяю…";
  try{await vault.unlock(i.value);await afterUnlock()}
  catch(x){lockFails++;if(lockFails>=5)lockWait=Date.now()+Math.min(300,15*2**(lockFails-5))*1000;
    err.textContent=x.code==="wrong"?(LOCK.kind==="pin"?"Неверный PIN-код":"Неверный пароль")+(lockFails>=5?". Следующая попытка через "+Math.ceil((lockWait-Date.now())/1000)+" с":""):"Не удалось открыть: "+(x.message||x);i.value="";i.focus()}
  finally{$("lockGo").disabled=false;$("lockGo").textContent="Открыть"}};
$("lockBio").onclick=async()=>{try{await vault.unlockBio();await afterUnlock()}catch(x){$("lockErr").textContent=x&&x.name==="NotAllowedError"?"Вход отменён":(x.message||"Не удалось войти по биометрии")}};
$("lockForgot").onclick=()=>{$("lockReset").hidden=!$("lockReset").hidden};
$("lockWipe").onclick=async()=>{if(($("wipeIn").value||"").trim().toUpperCase()!=="СТЕРЕТЬ"){$("wipeIn").focus();return}
  try{localStorage.clear()}catch(e){}await deleteEverything();bc&&bc.postMessage({vault:1});location.reload()};
async function lockNow(){
  if(!LOCK.on)return;await flushAll();if(REC)stopRec(true);
  closeMenu();closePop();closeModal();closeSettings();closeBackup();closeTasks();if(S.open)closeDay();
  S.days={};S.habits=[];S.templates=[];for(const k in HIST)delete HIST[k];
  for(const k in URLS){try{URL.revokeObjectURL(URLS[k])}catch(e){}delete URLS[k]}
  vault.lock();renderCal();showLock();
}
$("lockNow").onclick=()=>lockNow();
function renderLockSection(s,line,btn){
  if(LOCK.busy){const pr=el("div","meter"),i=el("i","m4");i.style.width=Math.round(LOCK.progress*100)+"%";pr.append(i);s.append(pr,el("p","bknote","Перешифровываю данные… "+Math.round(LOCK.progress*100)+"%"));return}
  const F=LOCK.form;
  if(!LOCK.on&&!F){
    s.append(el("p","bknote","PIN-код или пароль при входе. Все записи и файлы на устройстве хранятся зашифрованными: без кода их не прочитать, даже скопировав память браузера."));
    const r=el("div","row");btn(r,"Включить замок",()=>{LOCK.form={mode:"enable",kind:"pin"};renderBackup();setTimeout(()=>$("lk1")?.focus(),0)},"primary");s.append(r);return}
  if(F){
    if(F.mode!=="disable"){const seg=el("div","seg");[["pin","PIN-код"],["pass","Пароль"]].forEach(([k,l])=>{const b=el("button",F.kind===k?"on":"",l);b.type="button";b.onclick=()=>{F.kind=k;renderBackup()};seg.append(b)});s.append(seg)}
    const f=el("form","pwf");f.noValidate=true;
    const mk=(id,ph)=>{const i=el("input","inp");i.id=id;i.type="password";i.placeholder=ph;i.autocomplete=id==="lk0"?"current-password":"new-password";if((F.kind==="pin"&&id!=="lk0")||(id==="lk0"&&LOCK.kind==="pin"))i.inputMode="numeric";return i};
    if(F.mode==="disable")f.append(mk("lk0",LOCK.kind==="pin"?"Текущий PIN-код":"Текущий пароль"));
    else{f.append(mk("lk1",F.kind==="pin"?"PIN-код, от 4 цифр":"Пароль, от 8 символов"),mk("lk2","Повторите"));
      f.append(el("p","bknote","Если забыть код, данные на устройстве не открыть. Восстановить их можно только из бэкапа (у него свой пароль)."+(F.kind==="pin"?" PIN из 6+ цифр надёжнее; для серьёзной защиты выберите пароль.":"")))}
    const r=el("div","row"),ok=el("button","btn "+(F.mode==="disable"?"danger":"primary"),F.mode==="disable"?"Отключить замок":F.mode==="change"?"Сохранить":"Включить");ok.type="submit";
    const c=el("button","btn","Отмена");c.type="button";c.onclick=()=>{LOCK.form=null;LOCK.err="";renderBackup()};r.append(ok,c);f.append(r);
    if(LOCK.err)f.append(el("p","bkerr",LOCK.err));
    f.onsubmit=async e=>{e.preventDefault();LOCK.err="";
      if(F.mode==="disable"){const v=$("lk0").value;if(!v)return;LOCK.busy=true;renderBackup();
        try{await flushAll();await vault.disable(v,p=>{LOCK.progress=p;renderBackup()});LOCK.form=null;toast("Замок отключён, данные расшифрованы");bc&&bc.postMessage({vault:1})}
        catch(x){LOCK.err=x.code==="wrong"?"Неверный код":"Не удалось: "+(x.message||x)}LOCK.busy=false;await refreshLock();renderBackup();return}
      const a=$("lk1").value,b=$("lk2").value;
      if(F.kind==="pin"&&!/^\d{4,}$/.test(a))LOCK.err="PIN-код — от 4 цифр";else if(F.kind==="pass"&&a.length<8)LOCK.err="Пароль — от 8 символов";else if(a!==b)LOCK.err="Коды не совпадают";
      if(LOCK.err){renderBackup();return}
      if(F.mode==="change"){try{await vault.changeSecret(a,F.kind);LOCK.form=null;toast(F.kind==="pin"?"PIN-код изменён":"Пароль изменён")}catch(x){LOCK.err="Не удалось: "+(x.message||x)}await refreshLock();renderBackup();return}
      LOCK.busy=true;LOCK.progress=0;renderBackup();
      try{await flushAll();await vault.enable(a,F.kind,p=>{LOCK.progress=p;renderBackup()});LOCK.form=null;toast("Замок включён, данные зашифрованы");bc&&bc.postMessage({vault:1})}
      catch(x){LOCK.err="Не удалось включить замок: "+(x.message||x)}
      LOCK.busy=false;await refreshLock();renderBackup()};
    s.append(f);return}
  line(s,true,"Замок включён · "+(LOCK.kind==="pin"?"PIN-код":"пароль"),"Данные на устройстве зашифрованы.");
  const al=el("label","alrow");al.append(el("span",null,"Блокировать"));const sel=el("select","inp");sel.id="autoLock";
  [[0,"сразу при сворачивании"],[1,"через 1 минуту"],[5,"через 5 минут"],[15,"через 15 минут"],[60,"через час"],[-1,"только вручную"]].forEach(([v,l])=>{const o=el("option",null,l);o.value=v;if(LOCK.autoLock===v)o.selected=true;sel.append(o)});
  sel.onchange=async()=>{await vault.setAutoLock(+sel.value);await refreshLock()};al.append(sel);s.append(al);
  const r=el("div","row");btn(r,"Заблокировать сейчас",()=>lockNow(),"primary");btn(r,LOCK.kind==="pin"?"Сменить PIN-код":"Сменить пароль",()=>{LOCK.form={mode:"change",kind:LOCK.kind};renderBackup()});s.append(r);
  if(LOCK.bioAvail){const r2=el("div","row");
    if(LOCK.bio)btn(r2,"Отключить вход по Face ID / Touch ID",async()=>{await vault.disableBio();await refreshLock();renderBackup()});
    else btn(r2,"Входить по Face ID / Touch ID",async()=>{try{await vault.enableBio();toast("Вход по биометрии включён")}catch(x){toast(x&&x.name==="NotAllowedError"?"Отменено":(x.message||"Не удалось включить вход по биометрии"))}await refreshLock();renderBackup()});
    s.append(r2)}
  const r3=el("div","row");btn(r3,"Отключить замок",()=>{LOCK.form={mode:"disable"};renderBackup();setTimeout(()=>$("lk0")?.focus(),0)});s.append(r3);
  s.append(el("p","bknote","Даты записей видны в базе браузера открыто, содержимое — нет."));
}

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
$("back").onclick=closeDay;
$("wsMore").onclick=e=>{const r=e.currentTarget.getBoundingClientRect();openMenu(r.right-240,r.bottom+6,[
  {ic:"⌕",label:"Поиск",run:openSearch},
  {ic:"☑",label:"Незавершённые задачи",run:openTasks},
  {ic:"☰",label:"Слои",run:toggleLayers},
  {ic:"‹",label:"Предыдущий день",run:()=>shiftDay(-1)},
  {ic:"›",label:"Следующий день",run:()=>shiftDay(1)},
  "-",
  {ic:"Аа",label:"Оформление приложения",run:openSettings},
  {ic:"⛁",label:"Данные и бэкап",run:openBackup},
  ...(LOCK.on?[{ic:"🔒",label:"Заблокировать",run:()=>lockNow()}]:[])])};$("dPrev").onclick=()=>shiftDay(-1);$("dNext").onclick=()=>shiftDay(1);
addEventListener("keydown",e=>{
  if(document.body.classList.contains("locked"))return;
  const ae=document.activeElement,typing=/INPUT|TEXTAREA|SELECT/.test(ae.tagName)||ae.isContentEditable;
  const mod=e.ctrlKey||e.metaKey;
  if(e.key==="Escape"){
    const lb=document.querySelector(".lb");if(lb){lb.remove();return}
    if(menu){closeMenu();return}
    if($("modal")){closeModal();return}
    if($("pop")){closePop();return}
    if($("set")){closeSettings();return}if($("bk")){closeBackup();return}if($("tasks")){closeTasks();return}
    if(typing){ae.blur();return}
    if(S.open){if(W.mode!=="pan"){setMode("pan");return}if(W.multi.size)select(null);else closeDay()}return}
  if(mod&&e.code==="KeyK"){e.preventDefault();openSearch();return}
  if(!typing&&!mod&&e.key==="/"){e.preventDefault();openSearch();return}
  if($("modal"))return;
  if(S.open&&!typing&&mod&&e.code==="KeyZ"){e.preventDefault();undoRedo(e.shiftKey?1:-1);return}
  if(S.open&&!typing&&mod&&e.code==="KeyY"){e.preventDefault();undoRedo(1);return}
  if(S.open&&!typing&&mod&&e.code==="KeyG"){e.preventDefault();if(e.shiftKey)ungroupSel();else groupSel();return}
  if(S.open&&!typing&&mod&&e.code==="KeyA"){e.preventDefault();selectMany(day(S.open).blocks.filter(b=>!b.hidden).map(b=>b.id));return}
  if(S.open&&!typing&&W.multi.size&&(e.key==="Delete"||e.key==="Backspace")){e.preventDefault();removeMany([...W.multi]);return}
  if(S.open&&!typing&&W.sel&&mod&&(e.code==="BracketRight"||e.code==="BracketLeft")){e.preventDefault();const b=findB(W.sel);if(!b)return;
    if(e.code==="BracketRight")(e.shiftKey?front:up1)(b);else(e.shiftKey?back:down1)(b);return}
  if(S.open&&!typing&&!mod){if(e.code==="KeyL"){toggleLayers();return}if(e.code==="KeyP"){setMode(W.mode==="draw"?"pan":"draw");return}if(e.code==="KeyV"){setMode(W.mode==="select"?"pan":"select");return}}
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
  const p=$("bk");if(!p)return;const st=p.scrollTop;
  // Панель перерисовывается при обновлении статуса — введённое в поля и фокус сохраняем.
  const keep={};p.querySelectorAll("input[id]:not([type=file])").forEach(i=>{if(i.value)keep[i.id]=i.value});const fid=document.activeElement&&p.contains(document.activeElement)?document.activeElement.id:"";
  p.textContent="";
  const h=el("div","sethead");h.append(el("h2",null,"Данные и бэкап"));const x=el("button","btn icon","✕");x.setAttribute("aria-label","Закрыть");x.onclick=closeBackup;h.append(x);p.append(h);
  p.append(el("p","bkintro","Все записи и файлы хранятся только на этом устройстве. Никто, включая разработчиков, их не видит. Поэтому сохранность — в ваших руках: защитите хранилище и делайте бэкапы."));
  const sec=t=>{const s=el("section","sec");s.append(el("h3",null,t));p.append(s);return s};
  const line=(parent,ok,text,sub)=>{const r=el("div","stat "+(ok===true?"ok":ok===false?"warn":""));r.append(el("span","sdot"),Object.assign(el("div"),{}));const t=r.lastChild;t.append(el("b",null,text));if(sub)t.append(el("span",null,sub));parent.append(r);return r};
  const btn=(parent,label,fn,cls)=>{const b=el("button","btn"+(cls?" "+cls:""),label);b.onclick=fn;parent.append(b);return b};

  // 0. app lock
  renderLockSection(sec("Замок приложения"),line,btn);

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
  for(const [id,v] of Object.entries(keep)){const i=$(id);if(i&&p.contains(i)&&!i.value){i.value=v;i.dispatchEvent(new Event("input"))}}
  if(fid){const f=$(fid);if(f&&p.contains(f))f.focus({preventScroll:true})}
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
    await loadDays();S.habits=(await store.get("kv","habits"))||[];S.templates=(await store.get("kv","templates"))||[];for(const k in HIST)delete HIST[k];S.views={};if(S.open)closeDay();renderCal();bc&&bc.postMessage({reload:true});
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
  if(m.vault){location.reload();return}
  if(document.body.classList.contains("locked"))return;
  if(m.reload){await loadDays();S.habits=(await store.get("kv","habits"))||[];S.templates=(await store.get("kv","templates"))||[];if(S.open&&!$("ws").contains(document.activeElement))renderWs();renderCal();return}
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
let hiddenAt=0;
addEventListener("visibilitychange",async()=>{
  if(document.hidden){await flushAll();hiddenAt=Date.now();if(LOCK.on&&vault.isUnlocked()&&LOCK.autoLock===0)lockNow()}
  else{if(LOCK.on&&vault.isUnlocked()&&LOCK.autoLock>0&&hiddenAt&&Date.now()-hiddenAt>=LOCK.autoLock*6e4)lockNow();hiddenAt=0}
});
addEventListener("pagehide",()=>{flushAll()});

window.__tetrad={S,W}; // для отладки и автотестов
/* ---------- boot ---------- */
async function loadDays(){const all=await store.entries("days");S.days={};for(const [k,d] of all)if(d)S.days[k]=d}
async function loadPrivate(){
  if(!(await store.get("kv","init"))){
    const ex=examples();await store.bulk([...Object.entries(ex).map(([k,v])=>({s:"days",k,v:{...v,updatedAt:1}})),{s:"kv",k:"init",v:Date.now()}]);
  }
  await loadDays();
  S.habits=(await store.get("kv","habits"))||[];S.templates=(await store.get("kv","templates"))||[];
}
async function startApp(){
  try{await loadPrivate()}catch(e){$("modeHint").textContent="Хранилище недоступно: "+(e.message||e);console.error(e)}
  renderCal();
  const h=(location.hash||"").match(/^#d(\d{4}-\d{2}-\d{2})$/);if(h)openDay(h[1]);
  await refreshBK();
  gcFiles();
  setTimeout(()=>autoBackup(false),15000);
}
async function boot(){
  applyPrefs();renderCal();
  try{await loadPrefs();await refreshLock()}catch(e){console.error(e)}
  if(LOCK.on){vault.lock();showLock();return}
  await startApp();
}
boot();
