"use strict";
const CACHE="prompt-notebook-public-shell-v4-"+new URL(self.registration.scope).pathname;
const ASSETS=["./","./index.html","./styles.css","./storage.js","./app.js?v=4","./manifest.webmanifest","./icon.svg"];
self.addEventListener("install",event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)));});
self.addEventListener("activate",event=>{
  event.waitUntil((async()=>{const suffix="-"+new URL(self.registration.scope).pathname;for(const key of await caches.keys())if(key.startsWith("prompt-notebook-public-shell-") && key.endsWith(suffix) && key!==CACHE)await caches.delete(key);await self.clients.claim();})());
});
self.addEventListener("fetch",event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=="GET" || url.origin!==self.location.origin || !url.href.startsWith(self.registration.scope))return;
  if(event.request.mode==="navigate"){
    event.respondWith((async()=>{try{return await fetch(event.request,{signal:AbortSignal.timeout(3000)});}catch{const cached=await caches.match(new URL("./index.html",self.registration.scope));return cached || new Response("请联网打开一次以准备离线网页。",{status:503});}})());return;
  }
  if(!ASSETS.some(asset=>new URL(asset,self.registration.scope).href===url.href))return;
  event.respondWith(caches.match(event.request).then(cached=>cached || fetch(event.request)));
});
