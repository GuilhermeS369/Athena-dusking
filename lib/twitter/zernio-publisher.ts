import type { TwitterZernioError } from './zernio-client';

export type TwitterPublicationResolution='local_failure'|'confirmed_failure'|'rate_limited'|'accepted'|'published'|'existing_post'|'outcome_unknown';
export type TwitterMediaInput={type:'image'|'gif'|'video';url:string};

function record(value:unknown):Record<string,unknown>{return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};}
function text(value:unknown){return typeof value==='string'?value:'';}
function id(value:Record<string,unknown>){return [value._id,value.id].find((entry):entry is string=>typeof entry==='string'&&entry.length>0)??null;}

export function buildTwitterPostBody(input:{content:string;accountId:string;media:TwitterMediaInput[]}){
  if(!input.content.trim()&&!input.media.length)throw new Error('Conteúdo X vazio.');if(!input.accountId.trim())throw new Error('Conta X ausente.');
  const images=input.media.filter(item=>item.type==='image');const gifs=input.media.filter(item=>item.type==='gif');const videos=input.media.filter(item=>item.type==='video');
  if(images.length>4||gifs.length>1||videos.length>1||(images.length&&gifs.length)||(images.length&&videos.length)||(gifs.length&&videos.length))throw new Error('Combinação de mídia X inválida.');
  return{...(input.content.trim()?{content:input.content}:{}),mediaItems:input.media,platforms:[{platform:'twitter',accountId:input.accountId}],publishNow:true};
}

export function classifyTwitterPost(postValue:unknown,existing=false):{resolution:TwitterPublicationResolution;postId:string|null;providerCode:string;message:string}{
  const post=record(postValue);const platforms=Array.isArray(post.platforms)?post.platforms.map(record):[];const target=platforms.find(entry=>entry.platform==='twitter')??platforms[0]??{};const status=text(target.status||post.status).toLowerCase();const postId=id(post);
  if(existing)return{resolution:'existing_post',postId,providerCode:'existing_post',message:'Post existente confirmado pela Zernio.'};
  if(['published','success','posted','completed'].includes(status))return{resolution:'published',postId,providerCode:status,message:'Publicação confirmada pela Zernio.'};
  if(['failed','error','rejected','cancelled'].includes(status))return{resolution:'confirmed_failure',postId,providerCode:status,message:text(target.failureReason||target.error||target.message)||'Falha terminal confirmada pela Zernio.'};
  if(!postId)throw new Error('Zernio não retornou identificador do post.');
  return{resolution:'accepted',postId,providerCode:status||'accepted',message:'Zernio aceitou a publicação; aguardando resultado final.'};
}

export function classifyTwitterError(error:unknown){const typed=error as TwitterZernioError;const httpStatus=typed.httpStatus??null;if(typed.existingPostId)return{resolution:'existing_post' as const,httpStatus,postId:typed.existingPostId,retryAfterSeconds:null};if(httpStatus===429)return{resolution:'rate_limited' as const,httpStatus,postId:null,retryAfterSeconds:Math.max(typed.retryAfterSeconds??0,240)};if(httpStatus===null||httpStatus>=500)return{resolution:'outcome_unknown' as const,httpStatus,postId:null,retryAfterSeconds:null};return{resolution:'confirmed_failure' as const,httpStatus,postId:null,retryAfterSeconds:null};}
