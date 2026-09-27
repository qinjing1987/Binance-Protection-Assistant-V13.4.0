const test = require('node:test');
const assert = require('node:assert/strict');
const AIService = require('../server/ai/AIService');

function makeService(fetchImpl, providers, keys={}) {
  global.fetch = fetchImpl;
  return new AIService({
    credentials:{get:()=>({aiApiKeys:keys})},
    config:{get:()=>({ai:{providers,autoFailover:true}})}
  });
}
const p1={id:'p1',label:'P1',baseUrl:'https://p1.test',model:'m1',enabled:true};
const p2={id:'p2',label:'P2',baseUrl:'https://p2.test',model:'m2',enabled:true};

test('AI供应商失败时自动切换到下一家，并返回实际使用供应商', async () => {
  const calls=[];
  const svc=makeService(async (url,opt)=>{
    calls.push(url);
    if(url.includes('p1')) return new Response('bad',{status:503});
    return new Response(JSON.stringify({choices:[{message:{content:'{"action":"HOLD","symbol":"","stop_loss_pct":0,"take_profit_pct":0,"confidence":0,"reason":"ok"}'}}]}),{status:200,headers:{'content-type':'application/json'}});
  },[p1,p2],{p1:'k1',p2:'k2'});
  const r=await svc.analyze({gainers:[{symbol:'BTCUSDT'}],losers:[]});
  assert.equal(r.action,'HOLD');
  assert.equal(r.provider,'p2');
  assert.equal(calls.length,2);
});

test('没有Key的供应商不会被盲目调用', async () => {
  let calls=0;
  const svc=makeService(async ()=>{calls++;return new Response('{}',{status:500})},[p1],{});
  await assert.rejects(()=>svc.analyze({gainers:[{symbol:'BTCUSDT'}],losers:[]}),/未配置 API Key/);
  assert.equal(calls,0);
});


test('Ollama 本地供应商可免 API Key 调用', async () => {
  let auth = null;
  const local={id:'ollama',label:'Ollama',baseUrl:'https://ollama.test/v1',model:'qwen3:8b',enabled:true,requiresKey:false};
  const svc=makeService(async (url,opt)=>{
    auth=opt.headers.Authorization||null;
    return new Response(JSON.stringify({choices:[{message:{content:'{"action":"HOLD","symbol":"","stop_loss_pct":0,"take_profit_pct":0,"confidence":0,"reason":"local"}'}}]}),{status:200,headers:{'content-type':'application/json'}});
  },[local],{});
  const r=await svc.analyze({gainers:[{symbol:'BTCUSDT'}],losers:[]});
  assert.equal(r.provider,'ollama');
  assert.equal(auth,null);
});


test('开启免费 AI 优先后，免费供应商先尝试', async () => {
  const calls=[];
  const paid={id:'paid',label:'Paid',baseUrl:'https://paid.test',model:'m',enabled:true,requiresKey:true,free:false};
  const free={id:'ollama',label:'Ollama',baseUrl:'https://ollama.test/v1',model:'qwen3:8b',enabled:true,requiresKey:false,free:true};
  const svc=new AIService({
    credentials:{get:()=>({aiApiKeys:{paid:'k'}})},
    config:{get:()=>({ai:{providers:[paid,free],autoFailover:true,freeFirst:true}})}
  });
  global.fetch=async (url)=>{calls.push(url);return new Response(JSON.stringify({choices:[{message:{content:'{"action":"HOLD","symbol":"","stop_loss_pct":0,"take_profit_pct":0,"confidence":0,"reason":"free"}'}}]}),{status:200,headers:{'content-type':'application/json'}})};
  const r=await svc.analyze({gainers:[{symbol:'BTCUSDT'}],losers:[]});
  assert.equal(r.provider,'ollama');
  assert.equal(calls[0],'https://ollama.test/v1/chat/completions');
});
