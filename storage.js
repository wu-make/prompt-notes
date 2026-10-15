"use strict";
// No network calls. Both copies and recovery points stay in this browser.
class NotebookRecords {
  constructor(key,validate){this.key=key;this.validate=validate;this.connection=null;this.chain=Promise.resolve();}
  checksum(text){let hash=2166136261;for(let i=0;i<text.length;i++){hash^=text.charCodeAt(i);hash=Math.imul(hash,16777619);}return (hash>>>0).toString(16);}
  pack(value){const text=JSON.stringify(this.validate(value));return {text,checksum:this.checksum(text)};}
  unpack(record){if(!record || typeof record.text!=="string" || record.checksum!==this.checksum(record.text))throw Error("恢复副本校验失败");return this.validate(JSON.parse(record.text));}
  bounded(task,ms=1800){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error("本机备份存储响应超时")),ms);Promise.resolve(task).then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});}
  open(){
    if(!this.connection)this.connection=new Promise((resolve,reject)=>{
      let request,done=false;
      const timer=setTimeout(()=>finish(Error("本机备份存储响应超时")),1800);
      const finish=(error,database)=>{if(done){database?.close();return;}done=true;clearTimeout(timer);error?reject(error):resolve(database);};
      try{request=indexedDB.open(this.key+"-durable",1);
        request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains("records"))request.result.createObjectStore("records");};
        request.onsuccess=()=>{const database=request.result;database.onversionchange=()=>{database.close();this.connection=null;};finish(null,database);};
        request.onerror=()=>finish(request.error || Error("本机备份存储不可用"));request.onblocked=()=>finish(Error("本机备份存储被旧窗口占用，请关闭旧窗口"));
      }catch(error){finish(error);}
    }).catch(error=>{this.connection=null;throw error;});
    return this.connection;
  }
  async transaction(mode,run){
    const database=await this.open();
    return new Promise((resolve,reject)=>{
      let tx;try{tx=database.transaction("records",mode,{durability:"strict"});}catch{tx=database.transaction("records",mode);}
      let result;
      const timer=setTimeout(()=>{reject(Error("本机备份写入或读取超时"));try{tx.abort();}catch{}},1800);
      tx.oncomplete=()=>{clearTimeout(timer);resolve(result);};
      tx.onerror=tx.onabort=()=>{clearTimeout(timer);reject(tx.error || Error("本机备份存储操作失败"));};
      try{run(tx.objectStore("records"),value=>result=value);}catch(error){clearTimeout(timer);try{tx.abort();}catch{}reject(error);}
    });
  }
  saveLocal(value){
    const text=JSON.stringify(this.validate(value));let previous;
    try{const raw=localStorage.getItem(this.key);if(raw){const parsed=this.validate(JSON.parse(raw));if(parsed.exportedAt!==value.exportedAt)previous=this.pack(parsed);}}catch{}
    localStorage.setItem(this.key,text);
    if(previous)try{localStorage.setItem(this.key+"-previous",JSON.stringify(previous));}catch{}
  }
  async list(){
    const candidates=[];
    try{const raw=localStorage.getItem(this.key+"-previous");if(raw)candidates.push(this.unpack(JSON.parse(raw)));}catch{}
    const records=await this.transaction("readonly",(store,done)=>{const request=store.getAll();request.onsuccess=()=>done(request.result);});
    for(const record of records || [])try{candidates.push(this.unpack(record));}catch{}
    const unique=new Map(candidates.map(value=>[value.exportedAt,value]));return [...unique.values()].sort((a,b)=>Date.parse(b.exportedAt)-Date.parse(a.exportedAt));
  }
  localFallback(){try{return this.unpack(JSON.parse(localStorage.getItem(this.key+"-previous")));}catch{return null;}}
  save(value){
    const packed=this.pack(value),snapshot=JSON.parse(packed.text);
    const task=()=>this.transaction("readwrite",(store)=>{
      const current=store.get("latest");current.onsuccess=()=>{
        let old;try{old=this.unpack(current.result);}catch{}
        // Never let a delayed write from another tab replace a newer revision.
        if(old && Date.parse(old.exportedAt)>=Date.parse(snapshot.exportedAt))return;
        if(old){store.put(current.result,"previous");const minute=Math.floor(Date.parse(old.exportedAt)/60000);store.put(current.result,"history-"+(minute%5));}
        store.put(packed,"latest");
      };
    });
    this.chain=this.chain.then(task,task);return this.chain;
  }
}
