import { spawn } from 'node:child_process'
import { WebSocket } from 'ws'
import fs from 'node:fs'
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))
fs.writeFileSync('/tmp/opencode/chat-config.json', JSON.stringify({
  host:'127.0.0.1', port:8756, authToken:'t', dataDir:'/tmp/opencode/chat-data',
  providers:{ openai:{enabled:true, apiKeyEnv:'OPENAI_API_KEY', baseUrl:'http://127.0.0.1:9002/v1'},
    anthropic:{enabled:false,apiKeyEnv:'ANTHROPIC_API_KEY',baseUrl:'http://127.0.0.1:9002/v1'},
    deepseek:{enabled:false,apiKeyEnv:'DEEPSEEK_API_KEY',baseUrl:'http://127.0.0.1:9002/v1'},
    ollama:{enabled:false,baseUrl:'http://127.0.0.1:11434/v1'}},
  localOnly:false, notifications:{telegram:{},webhook:{}}, logging:{level:'info',redactSecrets:true}
},null,2))
const children=[]
try{
  children.push(spawn('node',['dist/index.js','provider','--port','9002'],{cwd:'/mnt/e/lab/burp/fixtures',stdio:'ignore'}))
  const sc=spawn('node',['dist/index.js'],{cwd:'/mnt/e/lab/burp/sidecar',env:{...process.env,CONFIG_PATH:'/tmp/opencode/chat-config.json',OPENAI_API_KEY:'sk-fake'},stdio:'ignore'})
  children.push(sc)
  await sleep(3500)
  const ws=new WebSocket('ws://127.0.0.1:8756')
  await new Promise((res,rej)=>{ws.once('open',res);ws.once('error',rej)})
  ws.send(JSON.stringify({jsonrpc:'2.0',method:'handshake.hello',params:{projectId:'p',nonce:'n',token:'t'}}))
  await sleep(200)
  let streamed=false
  ws.on('message',(raw)=>{ const m=JSON.parse(raw.toString()); if(m.method==='agent.event'&&m.params?.type==='text'){streamed=true; console.log('STREAM:',m.params.data.slice(0,80))} })
  const id=Date.now()
  ws.send(JSON.stringify({jsonrpc:'2.0',id,method:'agent.chat',params:{messages:[{role:'user',content:'hello world'}],model:'test-model',provider:'openai'}}))
  const res=await new Promise((resolve)=>{ ws.on('message',(raw)=>{const m=JSON.parse(raw.toString()); if(m.id===id) resolve(m)}) })
  console.log('CHAT RESULT:', JSON.stringify(res.result||res.error).slice(0,120))
  console.log(streamed?'STREAMING: PASS':'STREAMING: FAIL')
  ws.close()
} finally { children.forEach(c=>{try{c.kill('SIGKILL')}catch{}}) }
