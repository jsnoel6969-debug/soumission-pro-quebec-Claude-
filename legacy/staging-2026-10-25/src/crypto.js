import {pbkdf2,scrypt} from 'node:crypto';
const te=new TextEncoder();
// Standard scrypt parameters: 32 MiB, three passes; random 128-bit salt.
const deriveScrypt=(password,salt)=>new Promise((resolve,reject)=>scrypt(password,salt,32,{N:32768,r:8,p:3,maxmem:64*1024*1024},(error,key)=>error?reject(error):resolve(new Uint8Array(key))));
const derive=(password,salt)=>new Promise((resolve,reject)=>pbkdf2(password,salt,310000,32,'sha256',(error,key)=>error?reject(error):resolve(new Uint8Array(key))));
const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
function unhex(s){ if(!/^[a-f0-9]+$/i.test(s)||s.length%2)throw Error('format'); return new Uint8Array(s.match(/../g).map(x=>parseInt(x,16))); }
export async function passwordHash(password){
  if(typeof password!=='string'||password.length<12||password.length>200)throw new Error('Mot de passe : 12 à 200 caractères');
  const salt=crypto.getRandomValues(new Uint8Array(16));
  const derived=await deriveScrypt(te.encode(password),salt);
  return `scrypt$32768-8-3$${hex(salt)}$${hex(new Uint8Array(derived))}`;
}
export async function verifyPassword(password,stored){
  try{
    const [method,iters,salt,hash]=stored.split('$');
    if(!((method==='scrypt'&&iters==='32768-8-3')||(method==='pbkdf2-sha256'&&iters==='310000')))return false;
    if(salt.length!==32||hash.length!==64)return false;
    const derived=method==='scrypt'?await deriveScrypt(te.encode(password),unhex(salt)):await derive(te.encode(password),unhex(salt));
    const expected=unhex(hash);
    let diff=derived.length^expected.length;
    for(let i=0;i<Math.max(derived.length,expected.length);i++)diff|=(derived[i]||0)^(expected[i]||0);
    return diff===0;
  }catch{return false;}
}
export async function sha256(s){return hex(new Uint8Array(await crypto.subtle.digest('SHA-256',te.encode(s))));}
export function newToken(){return hex(crypto.getRandomValues(new Uint8Array(32)));}
