#!/usr/bin/env node
import assert from 'node:assert/strict';

function simulate({itemCount,connectionCount,slowConnection='connection-0'}){
  const deadlineSeconds=900,globalLimit=128,connectionLimit=8;
  const waiting=Array.from({length:itemCount},(_,index)=>({id:`item-${index}`,profileId:`profile-${index}`,connectionId:`connection-${index%connectionCount}`,duration:index%connectionCount===0?12:2}));
  const active=[];const activeProfiles=new Set();const activeByConnection=new Map();const completed=[];let now=0,maxActive=0;
  while(waiting.length||active.length){
    for(let index=active.length-1;index>=0;index-=1){const item=active[index];if(item.finishedAt>now)continue;active.splice(index,1);activeProfiles.delete(item.profileId);activeByConnection.set(item.connectionId,(activeByConnection.get(item.connectionId)??1)-1);completed.push(item);}
    let advanced=true;while(advanced&&active.length<globalLimit){advanced=false;const index=waiting.findIndex(item=>!activeProfiles.has(item.profileId)&&(activeByConnection.get(item.connectionId)??0)<connectionLimit);if(index>=0){const[item]=waiting.splice(index,1);active.push({...item,startedAt:now,finishedAt:now+item.duration});activeProfiles.add(item.profileId);activeByConnection.set(item.connectionId,(activeByConnection.get(item.connectionId)??0)+1);maxActive=Math.max(maxActive,active.length);advanced=true;}}
    if(active.length)now=Math.min(...active.map(item=>item.finishedAt));
  }
  assert.equal(completed.length,itemCount);assert.equal(new Set(completed.map(item=>item.id)).size,itemCount);assert.ok(maxActive<=globalLimit);assert.ok(now<=deadlineSeconds,`${itemCount} itens terminaram em ${now}s`);
  return{itemCount,connectionCount,completedInSeconds:now,maxActive,deadlineSeconds,withinDeadline:now<=deadlineSeconds,slowConnection};
}

const scenarios=[simulate({itemCount:1000,connectionCount:10}),simulate({itemCount:10000,connectionCount:100})];
console.log(JSON.stringify({ok:true,scenarios},null,2));
