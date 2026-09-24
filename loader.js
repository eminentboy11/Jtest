/**
 * JTEST LITE — Fixed Sync Loader for Courtney/Pterodactyl
 * - Persists auth + data OUTSIDE ephemeral Jtest-main folder
 * - Auth saved at /home/container/auth (survives restarts)
 * - Data (registry) at /home/container/data
 * - Copies back and forth, auto-sync every 30s
 * - Fixes "NO AUTH FOUND" and bot ID changing every restart
 */
'use strict';
const fs=require('fs'),path=require('path'),axios=require('axios'),AdmZip=require('adm-zip');
const ROOT=__dirname;
const TARGET=path.join(ROOT,'platform','lib_signals');
const PERSIST_AUTH=path.join(ROOT,'auth');
const PERSIST_DATA=path.join(ROOT,'data');
const REPO_URL=process.env.REPO_URL||"https://github.com/eminentboy11/Jtest/archive/refs/heads/main.zip";

function log(...a){console.log(...a);}

async function main(){
  fs.mkdirSync(TARGET,{recursive:true});
  fs.mkdirSync(PERSIST_AUTH,{recursive:true});
  fs.mkdirSync(PERSIST_DATA,{recursive:true});

  // Clean old extracted code but NEVER delete persist folders
  try{
    const keep = new Set(['auth','data']);
    for(const f of fs.readdirSync(TARGET)){
      if(keep.has(f)) continue;
      const full=path.join(TARGET,f);
      fs.rmSync(full,{recursive:true,force:true});
    }
    log(`[ SYNC ] Cleaned old code, kept [${fs.readdirSync(TARGET).join(', ')}]`);
  }catch(e){ log('[ SYNC ] Clean error', e.message); }

  log('[ SYNC ] Downloading', REPO_URL);
  const res=await axios.get(REPO_URL,{responseType:'arraybuffer',timeout:30000});
  const zip=new AdmZip(Buffer.from(res.data));
  let count=0;
  for(const entry of zip.getEntries()){
    if(entry.isDirectory) continue;
    // Skip auth/data from zip to preserve live
    const name=entry.entryName.replace(/\\/g,'/');
    if(name.includes('/auth/')||name.endsWith('/auth')||name.includes('/data/')||name.includes('platform-registry')) continue;
    const out=path.join(TARGET, entry.entryName);
    fs.mkdirSync(path.dirname(out),{recursive:true});
    fs.writeFileSync(out, entry.getData());
    count++;
  }
  log(`[ SYNC ] Extracted ${count} files`);

  const subfolders=fs.readdirSync(TARGET).filter(n=>{
    try{return fs.statSync(path.join(TARGET,n)).isDirectory();}catch{return false;}
  });
  if(!subfolders.length) throw new Error('No repo folder after extract');
  const repoRoot=path.join(TARGET, subfolders[0]);
  log('[ SYNC ] Repo root', repoRoot);

  // Restore persist -> repo
  try{
    if(fs.existsSync(PERSIST_AUTH) && fs.readdirSync(PERSIST_AUTH).length>0){
      fs.cpSync(PERSIST_AUTH, path.join(repoRoot,'auth'), {recursive:true,force:true});
      log(`[ SYNC ] Auth restored: ${fs.readdirSync(PERSIST_AUTH).length} bots from ${PERSIST_AUTH} -> ${path.join(repoRoot,'auth')}`);
    } else {
      log('[ SYNC ] No persist auth yet — will need pairing (first run)');
    }
  }catch(e){ log('[ SYNC ] Auth restore failed', e.message); }

  try{
    if(fs.existsSync(PERSIST_DATA)){
      fs.cpSync(PERSIST_DATA, path.join(repoRoot,'data'), {recursive:true,force:true});
      const hasReg=fs.existsSync(path.join(PERSIST_DATA,'platform-registry.json'));
      log(`[ SYNC ] Data restored: registry ${hasReg?'OK':'missing'}`);
    }
  }catch(e){ log('[ SYNC ] Data restore failed', e.message); }

  const authCheckPath=path.join(repoRoot,'auth');
  const dataCheckPath=path.join(repoRoot,'data');
  log(`[ SYNC ] Auth check: ${fs.existsSync(authCheckPath)?fs.readdirSync(authCheckPath).join(', ')||'empty':'NO AUTH FOUND — will need pairing'}`);
  log(`[ SYNC ] Data check: ${fs.existsSync(dataCheckPath)?fs.readdirSync(dataCheckPath).join(', '):'NO DATA'}`);

  log('[ BOT ] Launching...');
  process.chdir(repoRoot);

  // Auto-sync back persist every 30s + on exit
  const syncBack=()=>{
    try{
      if(fs.existsSync(path.join(repoRoot,'auth'))){
        fs.cpSync(path.join(repoRoot,'auth'), PERSIST_AUTH, {recursive:true,force:true});
      }
      if(fs.existsSync(path.join(repoRoot,'data'))){
        fs.cpSync(path.join(repoRoot,'data'), PERSIST_DATA, {recursive:true,force:true});
      }
    }catch{}
  };
  setInterval(syncBack, 30000);
  process.on('SIGINT',()=>{syncBack();process.exit(0);});
  process.on('SIGTERM',()=>{syncBack();process.exit(0);});

  await import(path.join(repoRoot,'index.js'));
}

main().catch(e=>{
  console.error('[ SYNC ] Fatal', e);
  setTimeout(()=>process.exit(1),3000);
});
