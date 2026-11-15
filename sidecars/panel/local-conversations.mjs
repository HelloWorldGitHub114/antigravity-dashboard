// Discover IDs only. Conversation bodies and SQLite contents are never read.
import {opendir,lstat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
export const conversationId=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const digest=value=>createHash('sha256').update(value).digest('hex');
async function stamp(file,directory=false){
 try{const s=await lstat(file,{bigint:true});if(s.isSymbolicLink()||!(directory?s.isDirectory():s.isFile()))return null;
  return [s.size,s.mtimeNs,s.ctimeNs,s.ino].map(String).join(':');
 }catch(e){if(e.code==='ENOENT'||e.code==='ENOTDIR')return null;throw e;}
}
export async function discoverLocalConversations({host,home=homedir(),limit=20000}={}){
 if(!['app','ide'].includes(host))throw Error('Explicit conversation host is required');
 const base=join(home,'.gemini',host==='ide'?'antigravity-ide':'antigravity');
 const files=new Map();let errors=0,visited=0,baseChecked=false,baseOk=false;
 for(const [name,directory] of [['conversations',false],['brain',true]]){
  const root=join(base,name);
  try{
   // Do not follow a redirected host root into another installation.
   if(!baseChecked){baseOk=Boolean(await stamp(base,true));baseChecked=true;}
   if(!baseOk||!await stamp(root,true))continue;
   const dir=await opendir(root);
   for await(const entry of dir){
    if(++visited>limit)throw Error('Conversation discovery budget exceeded');
    if(entry.isSymbolicLink()||!(directory?entry.isDirectory():entry.isFile()))continue;
    const id=directory?entry.name:entry.name.endsWith('.db')?entry.name.slice(0,-3):'';
    if(!conversationId.test(id))continue;
    const key=id.toLowerCase(),parts=files.get(key)||[];
    parts.push({file:join(root,entry.name),directory});files.set(key,parts);
   }
  }catch(e){if(!['ENOENT','ENOTDIR'].includes(e.code))errors++;}
  if(visited>limit)break;
 }
 const entries=[...files.entries()],slots=new Array(entries.length);
 let cursor=0;
 const worker=async()=>{
  while(cursor<entries.length){
   const index=cursor++;
   const [id,parts]=entries[index];
   const readSignature=async()=>{
    const rows=await Promise.all(parts.map(async({file,directory})=>{
     if(directory){
      const value=await stamp(file,true);
      return value===null?null:[['brain',value]];
     }
     const [value,wal]=await Promise.all([stamp(file,false),stamp(file+'-wal')]);
     return value===null?null:[['db',value],['wal',wal]];
    }));
    const values=[];
    for(const row of rows){if(row===null)return null;values.push(...row);}
    return digest(JSON.stringify(values));
   };
   try{const signature=await readSignature();if(signature)slots[index]={id,signature,readSignature};}
   catch{errors++;}
  }
 };
 const poolSize=Math.min(16,entries.length);
 if(poolSize>0)await Promise.all(Array.from({length:poolSize},worker));
 const conversations=[];
 for(const item of slots){if(item)conversations.push(item);}
 return {conversations,errors};
}
