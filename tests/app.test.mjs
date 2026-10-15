import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {IDBFactory} from 'fake-indexeddb';
const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
const source=await readFile(new URL('../app.js',import.meta.url),'utf8');
const storage=await readFile(new URL('../storage.js',import.meta.url),'utf8');
const seed=html.match(/<script id="initial-notes" type="application\/json">([\s\S]*?)<\/script>/)[1];
const KEY='prompt-notebook-public-v1:/prompt-notebook/';
function runtime({cache=new Map(),idb=new IDBFactory(),blocked=false}={}){
  const elements=new Map();
  function element(tag='div'){
    return {tagName:tag.toUpperCase(),children:[],textContent:'',value:'',hidden:false,disabled:false,style:{setProperty(){}},dataset:{},className:'',attributes:{},classList:{add(){}},append(...nodes){this.children.push(...nodes);},replaceChildren(...nodes){this.children=nodes;},setAttribute(key,value){this.attributes[key]=value;},focus(){},select(){},showModal(){this.open=true;},close(){this.open=false;},setCustomValidity(){},reportValidity(){},getBoundingClientRect(){return{width:244,height:330,left:0,right:244,bottom:330};},querySelector(tag){return this.children.find(n=>n.tagName===tag.toUpperCase());},click(){this.onclick?.({currentTarget:this});},remove(){},setSelectionRange(){}};
  }
  for(const match of html.matchAll(/\bid="([^"]+)"/g))elements.set(match[1],element());
  elements.get('initial-notes').textContent=seed;
  const doc={getElementById(id){if(!elements.has(id))throw Error('Missing actual element: '+id);return elements.get(id);},querySelectorAll(){return[];},createElement:element,addEventListener(){},body:element(),visibilityState:'visible'};
  const context=vm.createContext({console,document:doc,crypto:webcrypto,URL,Blob,Date,innerWidth:1280,innerHeight:900,location:{href:'https://example.test/prompt-notebook/'},indexedDB:idb,localStorage:{getItem:key=>cache.get(key)??null,setItem:(key,value)=>cache.set(key,String(value))},navigator:{storage:{persisted:async()=>false},clipboard:{writeText:async()=>{}},locks:{request:async(name,options,fn)=>typeof options==='function'?options():fn(blocked?null:{})}},isSecureContext:false,setTimeout:(fn,delay)=>{const timer=setTimeout(fn,Math.min(delay,100));timer.unref();return timer;},clearTimeout,addEventListener(){}});
  context.window=context;
  vm.runInContext(storage+'\n'+source+'\nthis.api={get:()=>snapshot(),ready:()=>!booting,flags:()=>({readOnly,tabBlocked,mirrorError,cacheError}),create:createNote,active:()=>activeId,update:updateNote,remove:deleteNote,restore:restoreNote,clear:clearTrash,confirm:()=>dialogAction?.(),import:selectImport,flush:()=>records.chain,history:()=>records.list(),render,setScope:value=>{scope=value;renderHome();}};',context);
  return {api:context.api,context,elements,cache,idb};
}
async function ready(r){for(let i=0;i<100 && !r.api.ready();i++)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(r.api.ready());await r.api.flush().catch(()=>{});}
const plain=value=>JSON.parse(JSON.stringify(value));
test('first visit is empty and create/edit survives reopening with colors and favorites',async()=>{
  const first=runtime();await ready(first);assert.equal(first.api.get().notes.length,0);first.api.create();const id=first.api.active();first.api.update(id,{title:'稳定性测试',content:'关键词 银河\n内容第二行',color:'green',pinned:true});await first.api.flush();
  const second=runtime({cache:first.cache,idb:first.idb});await ready(second);assert.deepEqual(plain(second.api.get().notes),plain(first.api.get().notes));second.elements.get('search').value='银河';second.api.setScope('all');assert.equal(second.elements.get('grid').children.length,1);
});
test('lost or corrupt primary storage recovers latest committed database copy',async()=>{
  const first=runtime();await ready(first);first.api.create();first.api.update(first.api.active(),{title:'必须恢复',content:'恢复内容'});await first.api.flush();first.cache.set(KEY,'{corrupted');
  const second=runtime({cache:first.cache,idb:first.idb});await ready(second);assert.equal(second.api.get().notes[0].title,'必须恢复');assert.equal(second.api.flags().readOnly,false);
  second.cache.delete(KEY);const third=runtime({cache:first.cache,idb:first.idb});await ready(third);assert.equal(third.api.get().notes[0].content,'恢复内容');
});
test('broken main storage with no valid recovery is never silently reset to empty',async()=>{
  const cache=new Map([[KEY,'{broken']]);const r=runtime({cache});await ready(r);assert.equal(r.api.flags().readOnly,true);assert.equal(cache.get(KEY),'{broken');assert.equal((await r.api.history()).length,0);assert.equal(r.elements.get('fatal').hidden,false);
});
test('database denied or permanently unresponsive exits loading and preserves local edits',async()=>{
  for(const idb of [{open(){throw Error('SecurityError');}},{open(){return{};}}]){const r=runtime({idb});await ready(r);r.api.create();assert.equal(r.api.get().notes.length,1);assert.ok(JSON.parse(r.cache.get(KEY)).notes.length);assert.ok(r.api.flags().mirrorError);assert.doesNotMatch(r.elements.get('save-message').textContent,/正在检查|正在读取/);await r.api.flush().catch(()=>{});}
});
test('second window cannot modify notes or override single-writer protection',async()=>{
  const r=runtime({blocked:true});await ready(r);r.api.create();assert.equal(r.api.get().notes.length,0);assert.equal(r.api.flags().tabBlocked,true);assert.equal(r.elements.get('new-note').disabled,true);assert.match(r.elements.get('save-message').textContent,/仅供查看/);
});
test('trash clear retains active records and does not purge a record restored after confirmation opened',async()=>{
  const r=runtime();await ready(r);r.api.create();const first=r.api.active();r.api.remove(first);r.api.confirm();r.api.clear();r.api.restore(first);r.api.confirm();assert.equal(r.api.get().notes.length,1);r.api.create();const second=r.api.active();r.api.remove(second);r.api.confirm();r.api.clear();r.api.confirm();assert.equal(r.api.get().notes.length,1);assert.equal(r.api.get().notes[0].id,first);await r.api.flush();
});
test('invalid import leaves state intact; valid imports preserve trash and skip duplicates',async()=>{
  const r=runtime();await ready(r);r.api.create();const before=JSON.stringify(r.api.get());await r.api.import({size:10,text:async()=>'{invalid'});assert.equal(JSON.stringify(r.api.get()),before);
  const backup={...plain(r.api.get()),notes:r.api.get().notes.map(n=>({...n,id:webcrypto.randomUUID(),title:'导入备份',deletedAt:Date.now()}))};
  const file={size:1000,text:async()=>JSON.stringify(backup)};await r.api.import(file);r.api.confirm();await r.api.import(file);r.api.confirm();assert.equal(r.api.get().notes.length,2);assert.ok(r.api.get().notes.find(n=>n.title==='导入备份').deletedAt);await r.api.flush();
});
test('valid import explicitly recovers a notebook whose cached data is unreadable',async()=>{
  const source=runtime();await ready(source);source.api.create();source.api.update(source.api.active(),{title:'备份恢复'});await source.api.flush();
  const r=runtime({cache:new Map([[KEY,'{broken']])});await ready(r);const value=plain(source.api.get());await r.api.import({size:1000,text:async()=>JSON.stringify(value)});r.api.confirm();await r.api.flush();assert.equal(r.api.flags().readOnly,false);assert.equal(r.api.get().notes[0].title,'备份恢复');
});
