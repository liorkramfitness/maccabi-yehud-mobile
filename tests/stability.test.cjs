const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('playwright');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
let browser;
before(async()=>{browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})})});
after(async()=>{await browser?.close()});

async function app(t){
  const page=await browser.newPage({viewport:{width:390,height:844},timezoneId:'America/Los_Angeles'});
  t.after(()=>page.close());
  await page.route('**/*',route=>route.fulfill({contentType:route.request().url().includes('cdn.jsdelivr.net')?'application/javascript':'text/html',body:route.request().url().includes('cdn.jsdelivr.net')?'':html}));
  await page.goto('https://app.test/');
  await page.evaluate(()=>{
    window.mock={writes:[],reads:[],tables:{},delays:{},releases:{},signOuts:[],signOutError:null};
    mock.client={
      from(table){return {
        select(){return {eq:async(column,id)=>{
          mock.reads.push({table,column,id});
          if(mock.delays[table])await new Promise(resolve=>mock.releases[table]=resolve);
          return {data:mock.tables[table]||[],error:null};
        }}},
        insert(data){
          mock.writes.push({table,data});
          const result=async()=>{if(mock.delays.write)await new Promise(resolve=>mock.releases.write=resolve);return {error:mock.writeError||null}};
          return {then(resolve,reject){return result().then(resolve,reject)},select(){return {single:async()=>({data:{id:'new-player'},error:null})}}};
        },
        async upsert(data,options){mock.writes.push({table,data,options});if(mock.delays.write)await new Promise(resolve=>mock.releases.write=resolve);return {error:mock.writeError||null}}
      }},
      auth:{
        onAuthStateChange(callback){mock.callback=callback;return {data:{subscription:{unsubscribe(){mock.unsubscribed=true}}}}},
        async getSession(){return {data:{session:{user:{id:'owner',email:'coach@example.test'}}},error:null}},
        async signOut(options){mock.signOuts.push(options);if(mock.signOutError)return {error:{message:'offline'}};mock.callback?.('SIGNED_OUT',null);return {error:null}},
        async signInWithPassword(){if(mock.delays.login)await new Promise(resolve=>mock.releases.login=resolve);mock.callback?.('SIGNED_IN',{user:{id:'owner',email:'coach@example.test'}});return {error:null}}
      }
    };
    window.supabase={createClient:()=>mock.client};
    localStorage.setItem(configKey,JSON.stringify({url:'https://example.supabase.co',key:'sb_publishable_test'}));
    mock.tables={
      my_teams:[{id:'team',birth_year:2012,team_name:'קבוצה פרטית',coach_name:'מאמן פרטי'}],
      my_players:[{id:'player',full_name:'שחקן פרטי',age_note:'14'}],
      my_team_players:[{id:'member',team_id:'team',player_id:'player'}],
      my_sessions:[{id:'session',team_id:'team',scheduled_date:'2026-11-17',session_status:'performed'}],
      my_attendance:[{session_id:'session',player_id:'player',attendance_status:'present',active_minutes:60,player_rpe:5}]
    };
    return connect();
  });
  return page;
}

test('logout clears all user arrays, rendered data, selections, drafts and passwords without database mutations',async t=>{
  const page=await app(t);
  await page.evaluate(()=>{
    for(const id of ['teamName','coachName','playerName','plannedContent','actualContent','sessionNotes','email','password','newpass','newpass2'])$(id).value='private draft';
    msg('playerMsg','private message');
    return $('logout').onclick();
  });
  const result=await page.evaluate(()=>({user,recovery,lengths:[teams,players,members,sessions,attendance].map(a=>a.length),text:document.body.textContent,values:[...document.querySelectorAll('main input,main textarea')].filter(i=>!['sbUrl','sbKey'].includes(i.id)).map(i=>i.value),selects:['playerTeam','rosterTeam','sessionTeam','loadTeam','attendanceSession'].map(id=>$(id).options.length),writes:mock.writes,signOuts:mock.signOuts,config:JSON.parse(localStorage.getItem(configKey))}));
  assert.equal(result.user,null);assert.equal(result.recovery,false);
  assert.deepEqual(result.lengths,[0,0,0,0,0]);assert.ok(result.values.every(v=>v===''));
  assert.deepEqual(result.selects,[0,0,0,0,0]);assert.ok(!result.text.includes('שחקן פרטי'));assert.ok(!result.text.includes('מאמן פרטי'));assert.ok(!result.text.includes('private message'));
  assert.deepEqual(result.writes,[]);assert.deepEqual(result.signOuts,[{scope:'local'}]);assert.equal(result.config.key,'sb_publishable_test');
});

test('SIGNED_OUT from another tab also clears private data',async t=>{
  const page=await app(t);
  await page.evaluate(()=>mock.callback('SIGNED_OUT',null));
  assert.equal(await page.evaluate(()=>user===null&&players.length===0&&!document.body.textContent.includes('שחקן פרטי')),true);
});

test('a delayed cloud read cannot repopulate data after logout',async t=>{
  const page=await app(t);
  await page.evaluate(()=>{mock.delays.my_teams=true;window.loading=loadAll()});
  await page.waitForFunction(()=>!!mock.releases.my_teams);
  await page.evaluate(()=>$('logout').onclick());
  await page.evaluate(async()=>{mock.releases.my_teams();await window.loading});
  assert.equal(await page.evaluate(()=>user===null&&teams.length===0&&!document.body.textContent.includes('שחקן פרטי')),true);
});

test('logout waits for a pending login before removing the local session',async t=>{
  const page=await app(t);
  await page.evaluate(()=>{mock.delays.login=true;window.loginTask=$('login').onclick()});
  await page.waitForFunction(()=>!!mock.releases.login);
  await page.evaluate(()=>{window.logoutTask=$('logout').onclick()});
  assert.equal(await page.evaluate(()=>players.length===0&&mock.signOuts.length===0),true);
  await page.evaluate(async()=>{mock.releases.login();await window.loginTask;await window.logoutTask});
  assert.equal(await page.evaluate(()=>user===null&&players.length===0&&mock.signOuts.length===1),true);
});

test('logout failure leaves private data cleared and provides a retry',async t=>{
  const page=await app(t);
  await page.evaluate(async()=>{mock.signOutError=true;await $('logout').onclick()});
  assert.equal(await page.evaluate(()=>user===null&&players.length===0&&!$('logged').classList.contains('hide')&&$('authMsg').textContent.includes('לא הושלמה')),true);
  await page.evaluate(async()=>{mock.signOutError=false;await $('logout').onclick()});
  assert.equal(await page.evaluate(()=>$('logged').classList.contains('hide')),true);
});

for(const id of ['addTeam','addPlayer','saveSession','saveAttendance']){
  test(`${id}: concurrent clicks produce only one save and unlock afterwards`,async t=>{
    const page=await app(t);
    await page.evaluate(()=>{mock.delays.write=true;$('teamYear').value='2012';$('teamName').value='נוער';$('coachName').value='מאמן';$('playerName').value='שחקן';$('sessionDate').value='2026-11-17'});
    await page.evaluate(id=>{window.firstSave=$(id).onclick();window.secondSave=$(id).onclick()},id);
    await page.waitForFunction(()=>!!mock.releases.write);
    assert.equal(await page.evaluate(id=>$(id).disabled,id),true);
    // Player creation includes a second, distinct membership write.
    assert.equal(await page.evaluate(id=>mock.writes.filter(w=>w.table===(id==='addPlayer'?'my_players':id==='addTeam'?'my_teams':id==='saveSession'?'my_sessions':'my_attendance')).length,id),1);
    await page.evaluate(async()=>{mock.releases.write();await window.firstSave;await window.secondSave});
    assert.equal(await page.evaluate(id=>$(id).disabled,id),false);
  });
}

test('failed save unlocks the button for retry',async t=>{
  const page=await app(t);
  await page.evaluate(async()=>{mock.writeError={message:'save failed'};$('teamYear').value='2012';$('teamName').value='קבוצה';$('coachName').value='מאמן';await $('addTeam').onclick()});
  assert.equal(await page.evaluate(()=>!$('addTeam').disabled&&$('teamMsg').textContent==='save failed'),true);
});

test('numeric validation accepts boundaries and rejects missing year, non-finite, out-of-range and invalid steps',async t=>{
  const page=await app(t);
  const results=await page.evaluate(()=>{
    const parse=(value,min,max,step=1,required=false)=>{try{return numberValue({value,validity:{badInput:false}},'בדיקה',min,max,step,required)}catch{return 'invalid'}};
    return {
      valid:[parse('0',0,300),parse('300',0,300),parse('0',0,10,.5),parse('10',0,10,.5),parse('4.5',0,10,.5),parse('2000',2000,2100,1,true),parse('2100',2000,2100,1,true),parse('',0,300)],
      invalid:[parse('',2000,2100,1,true),parse('1999',2000,2100,1,true),parse('2101',2000,2100,1,true),parse('2012.5',2000,2100,1,true),parse('-1',0,300),parse('301',0,300),parse('30.5',0,300),parse('10.5',0,10,.5),parse('4.2',0,10,.5),parse('NaN',0,300),parse('Infinity',0,300)]
    };
  });
  assert.deepEqual(results.valid,[0,300,0,10,4.5,2000,2100,null]);assert.ok(results.invalid.every(v=>v==='invalid'));
});

test('invalid session and attendance numbers never reach Supabase',async t=>{
  const page=await app(t);
  await page.evaluate(async()=>{
    $('sessionDate').value='2026-11-17';$('sessionMinutes').value='301';await $('saveSession').onclick();
    $('sessionMinutes').value='60';$('sessionRPE').value='4.2';await $('saveSession').onclick();
    document.querySelector('.att-rpe').value='11';await $('saveAttendance').onclick();
    document.querySelector('.att-rpe').value='5';document.querySelector('.att-min').value='-1';await $('saveAttendance').onclick();
  });
  assert.equal(await page.evaluate(()=>mock.writes.length),0);
});

test('Israel calendar date and seven-day bounds work across midnight, DST and year boundaries',async t=>{
  const page=await app(t);
  const results=await page.evaluate(()=>{
    const dates=['2026-11-16T22:30:00Z','2026-06-01T21:30:00Z','2026-10-24T22:30:00Z','2026-10-25T22:30:00Z','2026-12-31T22:30:00Z'].map(v=>israelDate(new Date(v)));
    sessions=['2026-11-10','2026-11-11','2026-11-17','2026-11-18'].map((scheduled_date,i)=>({id:String(i),team_id:'team',session_status:'performed',scheduled_date}));
    attendance=sessions.map(s=>({session_id:s.id,player_id:'player',attendance_status:'present',active_minutes:60,player_rpe:5}));
    return {dates,rows:loadRows('player','team',new Date('2026-11-16T22:30:00Z')).map(r=>r.session_id)};
  });
  assert.deepEqual(results.dates,['2026-11-17','2026-06-02','2026-10-25','2026-10-26','2027-01-01']);assert.deepEqual(results.rows,['1','2']);
});

test('loads include only performed sessions, participating players and valid personal reports in the selected team',async t=>{
  const page=await app(t);
  const rows=await page.evaluate(()=>{
    const variants=[['performed','present',60,5,'team'],['performed','late',30,4.5,'team'],['performed','partial',20,0,'team'],['cancelled','present',60,5,'team'],['planned','present',60,5,'team'],['replaced','present',60,5,'team'],['performed','absent',60,5,'team'],['performed','injured_not_participating',60,5,'team'],['performed','unknown',60,5,'team'],['performed','present',0,5,'team'],['performed','present',60,null,'team'],['performed','present',60,11,'team'],['performed','present',60,5,'other']];
    sessions=variants.map((v,i)=>({id:String(i),team_id:v[4],session_status:v[0],scheduled_date:'2026-11-17'}));
    attendance=variants.map((v,i)=>({session_id:String(i),player_id:'player',attendance_status:v[1],active_minutes:v[2],player_rpe:v[3]}));
    return loadRows('player','team',new Date('2026-11-17T10:00:00Z')).map(r=>r.session_id);
  });
  assert.deepEqual(rows,['0','1','2']);
});

test('mobile layout retains Hebrew RTL with no horizontal document overflow',async t=>{
  const page=await app(t);
  for(const width of [375,390,430]){
    await page.setViewportSize({width,height:844});
    for(const tab of ['dashboard','teams','sessions','attendance','loads','config']){
      await page.locator(`[data-tab="${tab}"]`).click();
      assert.equal(await page.evaluate(()=>document.documentElement.lang==='he'&&document.documentElement.dir==='rtl'&&document.documentElement.scrollWidth<=innerWidth),true);
    }
  }
});

test('a delayed saved write cannot restore private messages or data after logout',async t=>{
  const page=await app(t);
  await page.evaluate(()=>{mock.delays.write=true;$('teamYear').value='2012';$('teamName').value='קבוצה';$('coachName').value='מאמן';window.saveTask=$('addTeam').onclick()});
  await page.waitForFunction(()=>!!mock.releases.write);
  await page.evaluate(()=>{window.logoutTask=$('logout').onclick()});
  assert.equal(await page.evaluate(()=>teams.length===0&&user===null),true);
  await page.evaluate(async()=>{mock.releases.write();await window.saveTask;await window.logoutTask});
  assert.equal(await page.evaluate(()=>teams.length===0&&user===null&&$('teamMsg').textContent===''),true);
});

test('a delayed getSession response cannot restore a logged-out user',async t=>{
  const page=await app(t);
  await page.evaluate(()=>{
    mock.client.auth.getSession=()=>new Promise(resolve=>mock.releaseSession=()=>resolve({data:{session:{user:{id:'owner',email:'coach@example.test'}}},error:null}));
    window.connectTask=connect();
  });
  await page.waitForFunction(()=>!!mock.releaseSession);
  await page.evaluate(()=>$('logout').onclick());
  await page.evaluate(async()=>{mock.releaseSession();await window.connectTask});
  assert.equal(await page.evaluate(()=>user===null&&teams.length===0&&$('identity').textContent===''),true);
});

test('logout removes the local session without waiting for a hung data write',async t=>{
  const page=await app(t);
  await page.evaluate(()=>{mock.delays.write=true;$('teamYear').value='2012';$('teamName').value='קבוצה';$('coachName').value='מאמן';window.saveTask=$('addTeam').onclick()});
  await page.waitForFunction(()=>!!mock.releases.write);
  await page.evaluate(()=>$('logout').onclick());
  assert.equal(await page.evaluate(()=>mock.signOuts.length===1&&user===null&&teams.length===0),true);
  await page.evaluate(async()=>{mock.releases.write();await window.saveTask});
});

test('logout cancels a save queued in the same event turn',async t=>{
  const page=await app(t);
  await page.evaluate(async()=>{const saving=$('saveConfig').onclick();const leaving=$('logout').onclick();await Promise.all([saving,leaving])});
  assert.equal(await page.evaluate(()=>user===null&&mock.signOuts.length===1),true);
});
