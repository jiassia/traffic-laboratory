const transient=error=>error instanceof TypeError||/network|failed to fetch|fetch failed|load failed|connection|timed? ?out|\b(408|425|429|500|502|503|504)\b/i.test(String(error?.message||error));

export async function loadModelWithRetry(load,url,{wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  for(let attempt=0;;attempt++){
    try{return await load(url);}
    catch(error){
      if(attempt>=2||!transient(error))throw error;
      await wait(attempt===0?350:1000);
    }
  }
}
