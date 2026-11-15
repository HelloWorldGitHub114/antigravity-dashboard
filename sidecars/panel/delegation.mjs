// Verified host relationship fields only. Never infer delegation from titles,
// prompts, tool-result text, workspace paths or an ordinary conversation fork.
export const conversationId=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const normalizeConversationId=value=>typeof value==='string'&&conversationId.test(value)?value.toLowerCase():null;

export function delegatedIds(id,raw,summaries={}){
 const parent=normalizeConversationId(id);if(!parent)return [];
 const ids=new Set(),add=value=>{const child=normalizeConversationId(value);if(child&&child!==parent){const had=ids.has(child);ids.add(child);return !had;}return false;};
 const steps=raw?.trajectory?.steps??raw?.steps;
 if(Array.isArray(steps))for(const step of steps){
  const invocation=step?.invokeSubagent;
  if(invocation&&typeof invocation==='object'&&!Array.isArray(invocation)){
   add(invocation.conversationId);
   if(Array.isArray(invocation.subagents))for(const sub of invocation.subagents)add(sub?.conversationId);
   if(Array.isArray(invocation.results))for(const result of invocation.results)add(result?.conversationId);
  }
  const sendMessage=step?.sendMessage;
  if(sendMessage&&typeof sendMessage==='object'&&!Array.isArray(sendMessage))add(sendMessage.conversationId);
 }
 if(summaries&&typeof summaries==='object'&&!Array.isArray(summaries)){
  const entries=Object.entries(summaries);
  for(const [child,summary]of entries){
   const metadata=summary?.trajectoryMetadata;
   const p=normalizeConversationId(metadata?.parentConversationId),r=normalizeConversationId(metadata?.rootConversationId);
   if(p===parent||r===parent)add(child);
  }
  let added=true;
  while(added){
   added=false;
   for(const [child,summary]of entries){
    const metadata=summary?.trajectoryMetadata;
    const p=normalizeConversationId(metadata?.parentConversationId),r=normalizeConversationId(metadata?.rootConversationId);
    if((p&&ids.has(p))||(r&&ids.has(r)))if(add(child))added=true;
   }
  }
 }
 return [...ids];
}

export function delegatedHints(id,raw,summaries={},parentDepth=0){
 const parent=normalizeConversationId(id),hints=new Map();if(!parent)return hints;
 const baseDepth=Number.isInteger(parentDepth)&&parentDepth>=0?parentDepth:0;
 const merge=(childRaw,{role=null,parentId=null,depth=null}={})=>{
  const child=normalizeConversationId(childRaw);if(!child||child===parent)return;
  const prev=hints.get(child)||{role:null,parentId:null,depth:null};
  const nextRole=typeof role==='string'&&role.trim()?role.trim():null;
  const nextParent=normalizeConversationId(parentId);
  const nextDepth=Number.isInteger(depth)&&depth>=0?depth:null;
  hints.set(child,{
   role:nextRole||prev.role||null,
   parentId:nextParent||prev.parentId||null,
   depth:nextDepth??prev.depth??null,
  });
 };
 const steps=raw?.trajectory?.steps??raw?.steps;
 if(Array.isArray(steps))for(const step of steps){
  const inv=step?.invokeSubagent;
  if(inv&&typeof inv==='object'&&!Array.isArray(inv)){
   const subs=Array.isArray(inv.subagents)?inv.subagents:[];
   const results=Array.isArray(inv.results)?inv.results:[];
   const singleCid=normalizeConversationId(inv.conversationId);
   const maxLen=Math.max(subs.length,results.length);
   for(let i=0;i<maxLen;i++){
    const sub=subs[i]&&typeof subs[i]==='object'&&!Array.isArray(subs[i])?subs[i]:null;
    const res=results[i]&&typeof results[i]==='object'&&!Array.isArray(results[i])?results[i]:null;
    const cid=normalizeConversationId(res?.conversationId)||normalizeConversationId(sub?.conversationId)||(maxLen===1?singleCid:null);
    if(!cid)continue;
    const role=(typeof sub?.role==='string'?sub.role:'')||(typeof sub?.typeName==='string'?sub.typeName:'');
    merge(cid,{role:role.trim()||null,parentId:parent,depth:baseDepth+1});
   }
   if(singleCid&&!hints.has(singleCid))merge(singleCid,{parentId:parent,depth:baseDepth+1});
  }
  const send=step?.sendMessage;
  if(send&&typeof send==='object'&&!Array.isArray(send)){
   const sendCid=normalizeConversationId(send.conversationId);
   if(sendCid)merge(sendCid,{parentId:parent,depth:baseDepth+1});
  }
 }
 if(summaries&&typeof summaries==='object'&&!Array.isArray(summaries)){
  const descendants=new Set(delegatedIds(parent,raw,summaries));
  for(const [child,summary]of Object.entries(summaries)){
   const cid=normalizeConversationId(child);
   if(!cid||!descendants.has(cid))continue;
   const meta=summary?.trajectoryMetadata;
   const spec=meta?.subagentSpec;
   const rawRole=(typeof spec?.role==='string'?spec.role:'')||(typeof spec?.typeName==='string'?spec.typeName:'')||(typeof meta?.subagentRole==='string'?meta.subagentRole:'');
   const parentId=normalizeConversationId(meta?.parentConversationId)||(normalizeConversationId(meta?.rootConversationId)===parent?parent:null);
   const rawDepth=Number.isInteger(meta?.nestingDepth)?meta.nestingDepth:(Number.isInteger(meta?.subagentDepth)?meta.subagentDepth:null);
   merge(cid,{role:rawRole.trim()||null,parentId,depth:rawDepth});
  }
 }
 const resolveDepth=(cid,seen=new Set())=>{
  const entry=hints.get(cid);if(!entry)return null;
  if(Number.isInteger(entry.depth)&&entry.depth>=0)return entry.depth;
  if(!entry.parentId||seen.has(cid))return null;
  if(entry.parentId===parent)return baseDepth+1;
  seen.add(cid);
  const pd=resolveDepth(entry.parentId,seen);
  return Number.isInteger(pd)?pd+1:null;
 };
 for(const [cid,entry]of hints){
  if(entry.depth===null){
   const computed=resolveDepth(cid);
   if(computed!==null)entry.depth=computed;
  }
 }
 return hints;
}
