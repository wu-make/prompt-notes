"use strict";
// Everything is embedded; the CSP blocks all network connections.
const BOOK_KEY = "prompt-notebook-public-v1:"+new URL(".",location.href).pathname;
const COLORS = [{id:"blue",name:"蓝色",hex:"#4263eb"},{id:"violet",name:"紫色",hex:"#8056d9"},{id:"green",name:"绿色",hex:"#25836b"},{id:"orange",name:"橙色",hex:"#c87920"},{id:"rose",name:"粉色",hex:"#cc5377"},{id:"slate",name:"灰色",hex:"#68768a"}];
const PATHS = {book:'M4 4h6a4 4 0 0 1 4 2v15a4 4 0 0 0-4-2H4zM20 4h-6a4 4 0 0 0-4 2M14 6h6v13h-6',file:'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h6',plus:'M12 5v14M5 12h14',star:'m12 3 2.8 5.7 6.3.9-4.5 4.4 1.1 6.2-5.7-3-5.7 3 1.1-6.2L3.2 9.6l6.3-.9z',trash:'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',search:'M21 21l-5-5M18 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',x:'M6 6l12 12M18 6 6 18',more:'M4 12h.1M12 12h.1M20 12h.1',pencil:'m16 3 5 5-12 12-6 1 1-6zM13 6l5 5',copy:'M9 9h12v12H9zM15 9V3H3v12h6',back:'M19 12H5M12 5l-7 7 7 7',restore:'M3 10a9 9 0 1 1 2 8M3 3v7h7',download:'M12 3v12M7 10l5 5 5-5M4 16v5h16v-5',upload:'M12 15V3M7 8l5-5 5 5M4 16v5h16v-5',disk:'M5 3h13l3 3v15H3V3zM7 3v6h10V3M7 21v-8h10v8',folder:'M3 7V4h6l3 3h9v14H3z',check:'M5 12l4 4L19 6'};
const $ = id => document.getElementById(id);
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${PATHS[name] || PATHS.file}"></path></svg>`;
document.querySelectorAll('[data-icon]').forEach(el => el.innerHTML = icon(el.dataset.icon));
const uid = () => crypto.randomUUID ? crypto.randomUUID() : 'note-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
const noteColor = note => (COLORS.find(c => c.id === note.color) || COLORS[0]).hex;
let state, scope="all", activeId=null, menuId=null, undoId=null, dialogAction=null, dialogTargets=[], pendingImport=null;
let diskHandle=null, diskBaseline=null, diskTimer=null, diskChain=Promise.resolve(), diskPending=false, diskError="", cacheError="", readOnly=false, booting=true;
let toastTimer, dbPromise, fileSession=0;

function validateBackup(input) {
  if (!input || input.format!=="prompt-notebook" || input.version!==1 || typeof input.exportedAt!=="string" || !Number.isFinite(Date.parse(input.exportedAt)) || !Array.isArray(input.notes) || input.notes.length>10000) throw Error("请选择提示词笔记本导出的 JSON 文件，笔记数不能超过 10,000 条。");
  const ids=new Set();
  const notes=input.notes.map((n,i)=>{
    if (!n || typeof n.id!=="string" || !/^[a-zA-Z0-9-]{16,80}$/.test(n.id) || ids.has(n.id) || typeof n.title!=="string" || !n.title.trim() || n.title.length>80 || typeof n.content!=="string" || n.content.length>200000 || !COLORS.some(c=>c.id===n.color) || typeof n.pinned!=="boolean" || !Number.isSafeInteger(n.createdAt) || n.createdAt<0 || !Number.isSafeInteger(n.updatedAt) || n.updatedAt<0 || !(n.deletedAt===null || Number.isSafeInteger(n.deletedAt) && n.deletedAt>=0)) throw Error(`第 ${i+1} 条笔记格式无效或编号重复，尚未导入任何内容。`);
    ids.add(n.id);return {id:n.id,title:n.title.trim(),content:n.content,color:n.color,pinned:n.pinned,createdAt:n.createdAt,updatedAt:n.updatedAt,deletedAt:n.deletedAt};
  });
  return {format:"prompt-notebook",version:1,exportedAt:input.exportedAt,notes};
}
function encodeState(value) { return JSON.stringify(value,null,2); }
function snapshot() { return {format:"prompt-notebook",version:1,exportedAt:state.exportedAt,notes:state.notes.map(n=>({...n}))}; }
function showToast(text,undo=null) {
  clearTimeout(toastTimer);$("toast-message").textContent=text;undoId=undo;$("undo").hidden=!undo;$("toast").hidden=false;
  toastTimer=setTimeout(()=>{$("toast").hidden=true;},undo?8000:4200);
}
function baseSaveStatus() {
  const bar=$("save-bar");bar.className="save-bar";
  $("retry-file").hidden=!diskHandle || !diskError;
  $("save-file-label").textContent=diskHandle ? "另存数据文件" : "保存到本地文件";
  if (readOnly || cacheError || diskError) {bar.classList.add("error");$("save-message").textContent=cacheError || diskError || "当前无法安全保存。请导出备份后重新打开。";}
  else if (diskHandle) {bar.classList.add("saved-file");$("save-message").textContent=diskPending ? `正在保存到本地文件：${diskHandle.name}…` : `已保存到本地文件：${diskHandle.name}。下次双击网页继续使用。`;}
  else $("save-message").textContent="已自动保存在此浏览器。首次使用建议点“保存到本地文件”，让笔记也有独立的磁盘副本。";
  $("editor-status").textContent=cacheError || diskError ? "修改已保留，请检查上方保存提示" : diskPending ? "正在保存到本地文件…" : diskHandle ? "已保存到本地文件" : "已保存在此浏览器";
}
function commit(change) {
  if (readOnly || booting || tabBlocked) {showToast("正在读取或暂时无法保存，请稍后再试。");return false;}
  let base=state;
  try {const latest=localStorage.getItem(BOOK_KEY);if(latest) {const parsed=validateBackup(JSON.parse(latest));if(Date.parse(parsed.exportedAt)>Date.parse(state.exportedAt))base=parsed;}}
  catch { /* The current in-memory copy remains available for export. */ }
  const next={...base,notes:base.notes.map(n=>({...n}))};change(next.notes);
  next.exportedAt=new Date(Math.max(Date.now(),Date.parse(base.exportedAt)+1)).toISOString();state=next;
  try {records.saveLocal(snapshot());cacheError="";}
  catch {cacheError="浏览器无法保存，当前修改仍在此页。请保存到本地文件或立即导出备份，关闭页面可能丢失修改。";}
  queueMirror();queueDisk();renderCounts();saveStatus();return true;
}
function updateNote(id,patch) {return commit(notes=>{const n=notes.find(n=>n.id===id && n.deletedAt===null);if(n)Object.assign(n,patch,{updatedAt:Date.now()});});}
function deadline(task,ms,message) {
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(message)),ms);Promise.resolve(task).then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});
}
function db() {
  if(!dbPromise)dbPromise=new Promise((resolve,reject)=>{
    let request,finished=false;
    const finish=(error,database)=>{if(finished){database?.close();return;}finished=true;clearTimeout(timer);if(error)reject(error);else resolve(database);};
    const timer=setTimeout(()=>finish(Error("浏览器恢复文件关联超时，请用“打开数据文件”重新选择。")),1800);
    try{
      request=indexedDB.open(BOOK_KEY+"-files",1);
      request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains("settings"))request.result.createObjectStore("settings");};
      request.onsuccess=()=>{const database=request.result;database.onversionchange=()=>{database.close();dbPromise=null;};finish(null,database);};
      request.onerror=()=>finish(request.error || Error("浏览器无法恢复文件关联。"));
      request.onblocked=()=>finish(Error("文件关联被其他窗口占用，请关闭旧窗口后重新打开数据文件。"));
    }catch(error){finish(error);}
  }).catch(error=>{dbPromise=null;throw error;});
  return dbPromise;
}
async function setting(action,value) {
  const database=await db();return new Promise((resolve,reject)=>{
    const tx=database.transaction("settings",action==="get"?"readonly":"readwrite");
    const timer=setTimeout(()=>{reject(Error("读取文件关联超时，请用“打开数据文件”重新选择。"));try{tx.abort();}catch{}},1800);
    const request=action==="get"?tx.objectStore("settings").get("handle"):tx.objectStore("settings").put(value,"handle");let result;
    request.onsuccess=()=>result=request.result;
    tx.oncomplete=()=>{clearTimeout(timer);resolve(result);};
    tx.onerror=tx.onabort=()=>{clearTimeout(timer);reject(tx.error || Error("浏览器无法保存文件关联。"));};
  });
}
function queueDisk() {
  if(!diskHandle)return;
  diskPending=true;clearTimeout(diskTimer);diskTimer=setTimeout(()=>{diskTimer=null;void flushDisk();},500);
}
async function writeCurrentDisk() {
  if(!diskHandle)return;
  if(await diskHandle.queryPermission({mode:"readwrite"})!=="granted")throw Error("本地文件写入权限需要重新允许。点击“重新允许保存”；当前修改仍保存在此浏览器。");
  const current=await diskHandle.getFile();const currentText=await current.text();
  if(diskBaseline!==null && currentText!==diskBaseline)throw Error("数据文件在其他地方发生了修改。为避免覆盖，已暂停写入；请导出当前备份，再用“打开数据文件”读取最新版本。");
  const data=encodeState(snapshot());const writer=await diskHandle.createWritable();
  try{await writer.write(data);await writer.close();}catch(error){try{await writer.abort();}catch{}throw error;}
  diskBaseline=data;diskError="";
  diskPending=encodeState(snapshot())!==data;
  if(diskPending)queueDisk();saveStatus();
}
async function flushDisk() {
  if(tabBlocked)return;
  clearTimeout(diskTimer);diskTimer=null;
  const task=async()=>{try{if(navigator.locks)await navigator.locks.request(BOOK_KEY+"-write",writeCurrentDisk);else await writeCurrentDisk();}catch(error){diskError=error.message || "本地文件保存失败，请重试或导出备份。";diskPending=false;saveStatus();}};
  diskChain=diskChain.then(task,task);return diskChain;
}
function mergeNotes(existing,incoming) {
  const merged=new Map(existing.map(n=>[n.id,{...n}]));
  for(const n of incoming){const old=merged.get(n.id);if(!old || n.updatedAt>old.updatedAt)merged.set(n.id,{...n});}
  return [...merged.values()];
}
async function saveAs() {
  fileSession++;
  if(!window.showSaveFilePicker){exportBackup();showToast("此浏览器不支持直接写文件，已导出备份。建议用 Edge 或 Chrome 打开离线版。");return;}
  try{
    const handle=await showSaveFilePicker({suggestedName:"提示词笔记数据.json",types:[{description:"提示词笔记 JSON 数据",accept:{"application/json":[".json"]}}]});
    const file=await handle.getFile();if(file.size>10*1024*1024)throw Error("所选文件超过 10 MB，请使用新的数据文件。");
    const text=await file.text();const imported=text.trim()?validateBackup(JSON.parse(text)):null;
    await diskChain;diskHandle=handle;diskBaseline=text;diskError="";
    if(readOnly){if(imported)state=imported;readOnly=false;$("fatal").hidden=true;cacheError="";}
    if(imported)commit(notes=>notes.splice(0,notes.length,...mergeNotes(notes,imported.notes)));
    try{await setting("put",handle);}catch{showToast("已关联文件，但浏览器无法记住关联。下次使用“打开数据文件”即可。");}
    diskPending=true;saveStatus();await flushDisk();render();
    if(!diskError)showToast("已关联数据文件，后续修改会自动保存到磁盘。");
  }catch(error){if(error.name!=="AbortError")showToast(error.message || "未能保存文件，笔记仍保留在此页面。");}
}
async function openFile() {
  fileSession++;
  if(!window.showOpenFilePicker){$("import-file").click();return;}
  try{
    const [handle]=await showOpenFilePicker({multiple:false,types:[{description:"提示词笔记 JSON 数据",accept:{"application/json":[".json"]}}]});
    const permission=await handle.requestPermission({mode:"readwrite"});
    const file=await handle.getFile();if(file.size>10*1024*1024)throw Error("数据文件不能超过 10 MB。");
    const text=await file.text();const incoming=validateBackup(JSON.parse(text));
    await diskChain;diskHandle=permission==="granted"?handle:null;diskBaseline=text;diskError="";
    if(readOnly){state=incoming;readOnly=false;$("fatal").hidden=true;cacheError="";}
    if(!commit(notes=>notes.splice(0,notes.length,...mergeNotes(notes,incoming.notes))))return;
    if(diskHandle){try{await setting("put",handle);}catch{}await flushDisk();}
    render();showToast(permission==="granted"?"已打开数据文件，笔记会继续自动保存。":"已读取笔记。未获写入权限，请导出备份保留修改。");
  }catch(error){if(error.name!=="AbortError")showToast(error.message || "无法读取这个文件。");}
}
async function retryDisk() {
  try{
    if(await diskHandle.requestPermission({mode:"readwrite"})!=="granted")return;
    if(diskBaseline===null){
      const file=await diskHandle.getFile();if(file.size>10*1024*1024)throw Error("数据文件不能超过 10 MB。");
      const text=await file.text();const fromDisk=validateBackup(JSON.parse(text));
      if(Date.parse(fromDisk.exportedAt)>Date.parse(state.exportedAt)){state=fromDisk;try{localStorage.setItem(BOOK_KEY,encodeState(state));}catch{}render();}
      diskBaseline=text;
    }
    await flushDisk();
  }catch(error){showToast(error.message);}
}
function renderCounts() {
  const active=state.notes.filter(n=>n.deletedAt===null);$("note-count").textContent=active.length;$("all-count").textContent=active.length;$("favorite-count").textContent=active.filter(n=>n.pinned).length;$("trash-count").textContent=state.notes.length-active.length;
}
function button(label,cls,svg,action) {const el=document.createElement("button");el.className=cls;if(svg)el.innerHTML=icon(svg);if(label){const text=document.createElement("span");text.textContent=label;el.append(text);}el.onclick=action;return el;}
function renderHome() {
  const query=$("search").value.trim().toLocaleLowerCase();$("clear-search").hidden=!query;
  const base=state.notes.filter(n=>scope==="trash"?n.deletedAt!==null:n.deletedAt===null && (scope!=="favorites" || n.pinned));
  const notes=base.filter(n=>!query || n.title.toLocaleLowerCase().includes(query) || n.content.toLocaleLowerCase().includes(query)).sort((a,b)=>scope==="trash"?b.deletedAt-a.deletedAt:Number(b.pinned)-Number(a.pinned) || a.createdAt-b.createdAt || a.id.localeCompare(b.id));
  document.querySelectorAll('[data-scope]').forEach(el=>el.setAttribute("aria-pressed",String(el.dataset.scope===scope)));
  $("scope-title").textContent=(scope==="trash"?"回收站":scope==="favorites"?"收藏的笔记":"全部笔记")+(query?` · 找到 ${notes.length} 条`:"");
  $("scope-hint").textContent=scope==="trash"?"笔记会保留在这里，随时可以恢复。":"点击标题打开内容，收藏的笔记会排在最前面。";
  $("clear-trash").hidden=scope!=="trash";$("clear-trash").disabled=!base.length || readOnly;
  const grid=$("grid");grid.replaceChildren();grid.setAttribute("aria-label",scope==="trash"?"回收站笔记列表":"笔记标题列表");
  for(const note of notes){
    const card=document.createElement("li");card.className="card";card.style.setProperty("--note-color",noteColor(note));
    const symbol=document.createElement("span");symbol.className="symbol";symbol.innerHTML=icon("file");const title=document.createElement("span");title.className="card-title";title.textContent=note.title;
    if(scope==="trash"){
      const top=document.createElement("div");top.className="trash-title";top.append(symbol,title);
      const footer=document.createElement("div");footer.className="trash-footer";const date=document.createElement("small");date.textContent=new Date(note.deletedAt).toLocaleDateString("zh-CN")+" 删除";
      const restore=button("恢复笔记","button secondary","restore",()=>restoreNote(note.id));restore.setAttribute("aria-label","恢复笔记："+note.title);restore.disabled=readOnly || booting || tabBlocked;footer.append(date,restore);card.append(top,footer);
    }else{
      const open=button("","card-open",null,()=>openNote(note.id));open.setAttribute("aria-label","打开笔记："+note.title);open.append(symbol,title);
      open.onkeydown=e=>{if(e.key==="ContextMenu" || e.shiftKey && e.key==="F10"){e.preventDefault();const r=open.getBoundingClientRect();openMenu(note.id,r.left,r.bottom);}};
      const actions=document.createElement("div");actions.className="card-actions";
      const star=button("","icon-button"+(note.pinned?" starred":""),"star",()=>{if(updateNote(note.id,{pinned:!note.pinned}))renderHome();});star.setAttribute("aria-label",(note.pinned?"取消收藏：":"收藏置顶：")+note.title);star.setAttribute("aria-pressed",String(note.pinned));star.disabled=readOnly || booting || tabBlocked;
      const more=button("","icon-button","more",()=>{const r=more.getBoundingClientRect();openMenu(note.id,r.right-244,r.bottom+5);});more.setAttribute("aria-label","管理笔记："+note.title);more.setAttribute("aria-haspopup","menu");actions.append(star,more);card.append(open,actions);
      card.oncontextmenu=e=>{e.preventDefault();openMenu(note.id,e.clientX,e.clientY);};
    }grid.append(card);
  }
  $("empty").hidden=notes.length>0;$("grid").hidden=!notes.length;
  $("empty-icon").innerHTML=icon(query?"search":scope==="trash"?"trash":scope==="favorites"?"star":"file");
  $("empty-title").textContent=query?"没有找到相关笔记":scope==="trash"?"回收站是空的":scope==="favorites"?"还没有收藏笔记":"留住一个好用的提示词";
  $("empty-hint").textContent=query?"试试其他关键词，标题和内容都可以搜索。":scope==="trash"?"删除的笔记会出现在这里。":scope==="favorites"?"点击笔记右上角的星标，就能收藏并置顶。":"点击新建笔记，或导入已有备份。";
}
function renderEditor() {
  const note=state.notes.find(n=>n.id===activeId && n.deletedAt===null);if(!note){activeId=null;render();return;}
  const tabs=$("tabs");tabs.replaceChildren();
  for(const n of state.notes.filter(n=>n.deletedAt===null)) {const tab=button(n.title,"",null,()=>openNote(n.id));tab.setAttribute("role","tab");tab.setAttribute("aria-selected",String(n.id===activeId));tab.style.setProperty("--note-color",noteColor(n));tabs.append(tab);}
  $("editor-title").textContent=note.title;$("content").value=note.content;$("content").readOnly=readOnly || booting || tabBlocked;$("editor-symbol").style.setProperty("--note-color",noteColor(note));$("characters").textContent=note.content.length.toLocaleString("zh-CN")+" 字符";$("copy").disabled=!note.content;saveStatus();
}
function render() {renderCounts();$("home").hidden=!!activeId;$("editor").hidden=!activeId;$("back").hidden=!activeId;$("new-note").disabled=booting || readOnly || tabBlocked;if(activeId)renderEditor();else renderHome();saveStatus();}
function openNote(id){closeMenu();activeId=id;render();}
function goHome(){closeMenu();activeId=null;render();}
function createNote(){const id=uid(),now=Date.now();if(commit(notes=>notes.push({id,title:"未命名提示词",content:"",color:COLORS[notes.filter(n=>n.deletedAt===null).length%COLORS.length].id,pinned:false,createdAt:now,updatedAt:now,deletedAt:null}))){openNote(id);$("content").focus();}}
function restoreNote(id){if(commit(notes=>{const n=notes.find(n=>n.id===id && n.deletedAt!==null);if(n){n.deletedAt=null;n.updatedAt=Date.now();}})){render();showToast("笔记已恢复，可在全部笔记中打开。");}}
function closeMenu(){$("menu").hidden=true;menuId=null;}
function openMenu(id,x,y) {
  const note=state.notes.find(n=>n.id===id && n.deletedAt===null);if(!note)return;menuId=id;const menu=$("menu");menu.replaceChildren();
  const title=document.createElement("div");title.className="menu-title";title.textContent=note.title;menu.append(title);
  const rename=button("重命名笔记","","pencil",()=>renameNote(id));rename.setAttribute("role","menuitem");rename.disabled=readOnly || booting || tabBlocked;menu.append(rename);
  const favorite=button(note.pinned?"取消收藏置顶":"收藏置顶","","star",()=>{updateNote(id,{pinned:!note.pinned});closeMenu();render();});favorite.setAttribute("role","menuitem");favorite.disabled=readOnly || booting || tabBlocked;menu.append(favorite);
  const label=document.createElement("div");label.className="color-label";label.textContent="标签颜色";menu.append(label);
  const choices=document.createElement("div");choices.className="colors";choices.setAttribute("role","group");choices.setAttribute("aria-label","标签颜色");
  for(const color of COLORS){const choice=button("","",note.color===color.id?"check":null,()=>{updateNote(id,{color:color.id});closeMenu();render();});choice.style.background=color.hex;choice.title=color.name;choice.setAttribute("role","menuitemradio");choice.setAttribute("aria-label",color.name);choice.setAttribute("aria-checked",String(note.color===color.id));choice.disabled=readOnly || booting || tabBlocked;choices.append(choice);}menu.append(choices);
  const remove=button("删除笔记","delete","trash",()=>deleteNote(id));remove.setAttribute("role","menuitem");remove.disabled=readOnly || booting || tabBlocked;menu.append(remove);menu.hidden=false;
  const rect=menu.getBoundingClientRect();menu.style.left=Math.max(10,Math.min(x,innerWidth-rect.width-10))+"px";menu.style.top=Math.max(10,Math.min(y,innerHeight-rect.height-10))+"px";rename.focus();
}
function showDialog(title,body,confirmLabel,action,{danger=false,focusInput=false}={}) {
  closeMenu();$("dialog-title").textContent=title;$("dialog-body").replaceChildren(...body);$("confirm").textContent=confirmLabel;$("confirm").className="button "+(danger?"danger":"primary");dialogAction=action;$("dialog").showModal();(focusInput?$("dialog-body").querySelector("input"):$("cancel")).focus();if(focusInput)$("dialog-body").querySelector("input").select();
}
function paragraph(text,cls=""){const p=document.createElement("p");p.textContent=text;p.className=cls;return p;}
function cancelDialog(){$("dialog").close();dialogAction=null;pendingImport=null;}
function renameNote(id) {
  const note=state.notes.find(n=>n.id===id);if(!note)return;const label=document.createElement("label");label.textContent="笔记名称";label.htmlFor="new-title";const input=document.createElement("input");input.id="new-title";input.value=note.title;input.maxLength=80;input.required=true;
  showDialog("重命名笔记",[label,input],"保存名称",()=>{if(!input.value.trim()){input.focus();input.setCustomValidity("请输入笔记名称。");input.reportValidity();return false;}if(!updateNote(id,{title:input.value.trim()}))return false;render();return true;},{focusInput:true});input.oninput=()=>input.setCustomValidity("");
}
function deleteNote(id){const note=state.notes.find(n=>n.id===id);if(!note)return;showDialog("删除这条笔记？",[paragraph(`「${note.title}」将移入回收站，之后仍可恢复。`)],"删除笔记",()=>{if(!updateNote(id,{deletedAt:Date.now()}))return false;if(activeId===id)activeId=null;render();showToast("笔记已移入回收站。",id);return true;},{danger:true});}
function clearTrash(){dialogTargets=state.notes.filter(n=>n.deletedAt!==null).map(n=>({id:n.id,updatedAt:n.updatedAt,deletedAt:n.deletedAt}));if(!dialogTargets.length)return;
  showDialog("清空回收站？",[paragraph(`将永久删除回收站中的全部 ${dialogTargets.length} 条笔记，清空后无法通过回收站恢复。主页中的笔记不会被删除。`),paragraph("已导出的备份可能仍保留旧笔记。如需保留副本，请先取消并导出备份。","policy")],"永久清空",()=>{let removed=0;if(!commit(notes=>{for(let i=notes.length-1;i>=0;i--){const n=notes[i];if(n.deletedAt!==null && dialogTargets.some(t=>t.id===n.id && t.updatedAt===n.updatedAt && t.deletedAt===n.deletedAt)){notes.splice(i,1);removed++;}}}))return false;render();showToast(`已永久清除 ${removed} 条笔记。`);return true;},{danger:true});
}
function exportBackup(){const link=document.createElement("a");const url=URL.createObjectURL(new Blob([encodeState(snapshot())],{type:"application/json"}));link.href=url;link.download="提示词笔记备份-"+new Date().toLocaleDateString("sv-SE")+".json";document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);showToast(`已导出 ${state.notes.length} 条笔记（含回收站）。`);}
async function selectImport(file){if(!file)return;try{if(file.size>10*1024*1024)throw Error("备份文件不能超过 10 MB。");const backup=validateBackup(JSON.parse((await file.text()).replace(/^\uFEFF/,"")));pendingImport=backup;const trash=backup.notes.filter(n=>n.deletedAt!==null).length;
    showDialog("导入备份",[paragraph(`已读取 ${backup.notes.length} 条笔记：${backup.notes.length-trash} 条普通笔记，${trash} 条回收站笔记。`),paragraph("只添加新笔记，不覆盖已有笔记；重复导入会自动跳过。","policy")],"确认导入",()=>{if(readOnly && !tabBlocked){readOnly=false;$("fatal").hidden=true;}let added=0;if(!commit(notes=>{const ids=new Set(notes.map(n=>n.id));for(const n of backup.notes)if(!ids.has(n.id)){notes.push({...n});ids.add(n.id);added++;}}))return false;render();showToast(`导入完成：新增 ${added} 条，跳过 ${backup.notes.length-added} 条重复笔记。`);return true;});
  }catch(error){showToast(error instanceof SyntaxError?"JSON 格式错误，尚未导入任何内容。":error.message);}finally{$("import-file").value="";}}
async function copyContent(){const note=state.notes.find(n=>n.id===activeId);if(!note || !note.content)return;try{await navigator.clipboard.writeText(note.content);showToast("内容已复制。");}catch{const input=$("content"),start=input.selectionStart,end=input.selectionEnd;input.focus();input.select();try{if(!document.execCommand("copy"))throw Error();showToast("内容已复制。");input.setSelectionRange(start,end);}catch{showToast("请按 Ctrl + C 复制已选中的内容。");}}}

$("brand").onclick=goHome;$("back").onclick=goHome;$("new-note").onclick=createNote;
$("search").oninput=renderHome;$("clear-search").onclick=()=>{$("search").value="";renderHome();$("search").focus();};
document.querySelectorAll('[data-scope]').forEach(el=>el.onclick=()=>{scope=el.dataset.scope;renderHome();});
$("copy").onclick=copyContent;$("rename-title").onclick=()=>renameNote(activeId);$("editor-menu").onclick=e=>{const r=e.currentTarget.getBoundingClientRect();openMenu(activeId,r.right-244,r.bottom+5);};
$("content").oninput=e=>{if(updateNote(activeId,{content:e.target.value})){$("characters").textContent=e.target.value.length.toLocaleString("zh-CN")+" 字符";$("copy").disabled=!e.target.value;}};
$("content").onkeydown=e=>{if(e.key==="Tab"){e.preventDefault();const input=e.target;input.setRangeText("  ",input.selectionStart,input.selectionEnd,"end");input.dispatchEvent(new Event("input"));}};
$("export").onclick=exportBackup;$("import").onclick=()=>$("import-file").click();$("import-file").onchange=e=>void selectImport(e.target.files[0]);$("clear-trash").onclick=clearTrash;
$("save-file").onclick=()=>void saveAs();$("open-file").onclick=()=>void openFile();$("retry-file").onclick=()=>void retryDisk();
$("dialog-close").onclick=cancelDialog;$("cancel").onclick=cancelDialog;$("dialog").oncancel=()=>{dialogAction=null;pendingImport=null;};
$("dialog-form").onsubmit=e=>{e.preventDefault();if(dialogAction && dialogAction()!==false)cancelDialog();};
$("toast-close").onclick=()=>{$("toast").hidden=true;};$("undo").onclick=()=>{if(undoId)restoreNote(undoId);};
document.addEventListener("pointerdown",e=>{if(!$("menu").hidden && !$("menu").contains(e.target))closeMenu();});
window.addEventListener("resize",closeMenu);window.addEventListener("keydown",e=>{if(e.key==="Escape")closeMenu();if((e.ctrlKey || e.metaKey) && e.key.toLowerCase()==="s"){e.preventDefault();if(diskHandle)void flushDisk();else showToast("修改已保存在此浏览器。点击“保存到本地文件”可保留磁盘副本。");}});
window.addEventListener("beforeunload",e=>{if(diskPending || cacheError){e.preventDefault();e.returnValue="";}});
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="hidden" && diskPending)void flushDisk();});
window.addEventListener("storage",e=>{if(e.key!==BOOK_KEY || !e.newValue)return;try{const incoming=validateBackup(JSON.parse(e.newValue));if(Date.parse(incoming.exportedAt)>Date.parse(state.exportedAt)){state=incoming;render();}}catch{}});
async function restoreLinkedFile(){
  const session=fileSession,initialState=state;
  try{
    const handle=await setting("get");
    if(session!==fileSession || !handle)return;
    const restored=await deadline((async()=>{
      const permission=await handle.queryPermission({mode:"readwrite"});
      if(permission!=="granted")return {permission};
      const file=await handle.getFile();if(file.size>10*1024*1024)throw Error("数据文件超过 10 MB，请先导出当前备份。");
      const text=await file.text();return {permission,text,backup:validateBackup(JSON.parse(text))};
    })(),2500,"关联的数据文件读取超时。现有笔记已显示，请点击“打开数据文件”重新选择。");
    if(session!==fileSession)return;
    // A delayed restore must never replace edits or a file chosen by the user.
    if(state!==initialState){diskError="已保留刚才的修改。文件读取期间笔记发生了变化，请用“打开数据文件”合并后继续保存。";saveStatus();return;}
    diskHandle=handle;
    if(restored.permission==="granted") {
      diskBaseline=restored.text;const fromDisk=restored.backup;
      if(readOnly || !hadCache || Date.parse(fromDisk.exportedAt)>Date.parse(state.exportedAt)) {
        state=fromDisk;readOnly=false;$("fatal").hidden=true;
        try{localStorage.setItem(BOOK_KEY,encodeState(state));cacheError="";}catch{cacheError="已读取数据文件，但浏览器保存区不可用；后续修改将保存到已关联的本地文件。";}
      }
      if(encodeState(state)!==diskBaseline)queueDisk();
      queueMirror();
    }else{
      diskBaseline=null;diskError="笔记已显示；数据文件写入权限需重新允许。点击“重新允许保存”即可。";
    }
  }catch(error){if(session!==fileSession)return;diskError=error?.message || "无法恢复上次的文件关联。现有笔记已显示，请用“打开数据文件”重新选择。";}
  render();
}

const records=new NotebookRecords(BOOK_KEY,validateBackup);
let mirrorPending=0,mirrorError="",mirrorReady=false,tabBlocked=false,hadCache=false;
function saveStatus(){
  baseSaveStatus();
  if(tabBlocked){$("save-bar").classList.add("error");$("save-message").textContent="此浏览器已有一个笔记本窗口正在编辑。当前窗口仅供查看；关闭另一窗口后刷新本页即可编辑。";}
  else if(booting)$("save-message").textContent="已显示本机笔记，正在检查恢复副本…";
  else if(!diskError && !cacheError){
    if(mirrorError){$("save-bar").classList.add("error");$("save-message").textContent="笔记已保存在此浏览器的快速存储；第二份本机副本暂时不可用。请关联本地文件或导出备份。";}
    else if(!diskHandle)$("save-message").textContent=mirrorPending?"已快速保存，正在写入第二份本机副本…":"已自动保存到本机浏览器的两处存储，不上传服务器。建议另外导出备份。";
  }
  if(mirrorPending && !diskPending)$("editor-status").textContent="已快速保存，正在写入本机副本…";
  else if(mirrorError)$("editor-status").textContent="已保留笔记，请检查上方保存提示";
}
function queueMirror(){
  if(!mirrorReady || tabBlocked)return Promise.resolve();
  mirrorPending++;const value=snapshot();
  return records.save(value).then(()=>{mirrorError="";},error=>{mirrorError=error.message || "本机副本保存失败";}).finally(()=>{mirrorPending--;saveStatus();});
}
async function acquireWriteLock(){
  if(!navigator.locks)return;
  await new Promise(resolve=>{
    navigator.locks.request(BOOK_KEY+"-editor",{ifAvailable:true},lock=>{
      if(!lock){tabBlocked=true;resolve();return;}
      resolve();return new Promise(()=>{});
    }).catch(()=>resolve());
  });
}
function safetyInfo(){
  showDialog("保存说明",[
    paragraph("笔记只保存在这台设备、当前浏览器的网站存储中。我们没有笔记服务器、登录系统或笔记上传接口；GitHub 仅提供网页文件。"),
    paragraph("笔记会自动保存在当前浏览器，下次打开可以继续使用。删除的笔记会进入回收站，可以在那里恢复。"),
    paragraph("本机的两份存储仍可能同时被清除。主动清除网站数据、卸载浏览器或设备损坏时，需要独立文件备份恢复。建议关联本地数据文件，或每周导出备份。","policy"),
    paragraph("更换浏览器、设备或网址不会自动同步。共用同一浏览器配置的人也能看到这里的笔记；这不是加密保险箱。")
  ],"知道了",()=>true);
}
$("safety").onclick=safetyInfo;
window.addEventListener("beforeunload",event=>{if(mirrorPending || cacheError && mirrorError){event.preventDefault();event.returnValue="";}});
window.addEventListener("online",()=>showToast("网络已恢复。笔记仍只保存在本机。"));

async function boot(){
  state=validateBackup(JSON.parse($("initial-notes").textContent));
  try{const raw=localStorage.getItem(BOOK_KEY);if(raw){state=validateBackup(JSON.parse(raw));hadCache=true;}}
  catch{readOnly=true;cacheError="快速保存区无法读取，正在尝试本机恢复副本。";}
  render();await acquireWriteLock();
  let candidates=[];
  try{candidates=await records.list();mirrorReady=true;}
  catch(error){mirrorError=error.message;mirrorReady=true;const previous=records.localFallback();if(previous)candidates=[previous];}
  const recovered=candidates[0];
  if(recovered && (readOnly || !hadCache || Date.parse(recovered.exportedAt)>Date.parse(state.exportedAt))){state=recovered;readOnly=false;cacheError="";hadCache=true;}
  if(!tabBlocked){
    if(!readOnly)try{records.saveLocal(snapshot());cacheError="";}catch{cacheError="浏览器快速保存不可用。请等待本机副本写入完成，并关联文件或导出备份。";}
    if(!readOnly && !mirrorError){
      try{await records.save(snapshot());mirrorError="";readOnly=false;}
      catch(error){mirrorError=error.message;}
    }
  }
  booting=false;
  if(readOnly){$("fatal").hidden=false;$("fatal").textContent="无法安全读取已有笔记。请打开本地数据文件或导入备份；现有存储未被清空。";}
  render();
  if(!tabBlocked)void restoreLinkedFile();
  if("serviceWorker" in navigator && isSecureContext){
    navigator.serviceWorker.register("./sw.js").catch(()=>{showToast("离线缓存暂时不可用，笔记保存不受影响。");});
  }
}
void boot().catch(()=>{booting=false;readOnly=true;$("new-note").disabled=true;$("fatal").hidden=false;$("fatal").textContent=$("save-message").textContent="本机存储初始化失败。原数据未清空，请刷新或打开已导出的备份文件。";});
