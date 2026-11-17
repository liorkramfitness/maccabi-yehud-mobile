const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const sql=fs.readFileSync(path.join(__dirname,'../sql/create_player_with_team.sql'),'utf8');
const owner='00000000-0000-4000-8000-000000000001';
const other='00000000-0000-4000-8000-000000000002';
const team='10000000-0000-4000-8000-000000000001';
const otherTeam='10000000-0000-4000-8000-000000000002';
const rejectedTeam='10000000-0000-4000-8000-000000000003';
let db;
before(async()=>{
  // Isolated in-memory PostgreSQL only. No Supabase connection or production data.
  db=new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE TABLE public.my_teams(id uuid PRIMARY KEY,owner_id uuid NOT NULL,UNIQUE(owner_id,id));
    CREATE TABLE public.my_players(id uuid PRIMARY KEY,owner_id uuid NOT NULL,full_name text NOT NULL,age_note text,UNIQUE(owner_id,id));
    CREATE TABLE public.my_team_players(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_id uuid NOT NULL,team_id uuid NOT NULL,player_id uuid NOT NULL,
      FOREIGN KEY(owner_id,team_id) REFERENCES public.my_teams(owner_id,id),
      FOREIGN KEY(owner_id,player_id) REFERENCES public.my_players(owner_id,id),
      CHECK(team_id<>'${rejectedTeam}'::uuid)
    );
    INSERT INTO public.my_teams VALUES('${team}','${owner}'),('${otherTeam}','${other}'),('${rejectedTeam}','${owner}');
    ALTER TABLE public.my_teams ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.my_players ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.my_team_players ENABLE ROW LEVEL SECURITY;
    CREATE POLICY owner_only ON public.my_teams TO authenticated USING(owner_id=auth.uid()) WITH CHECK(owner_id=auth.uid());
    CREATE POLICY owner_only ON public.my_players TO authenticated USING(owner_id=auth.uid()) WITH CHECK(owner_id=auth.uid());
    CREATE POLICY owner_only ON public.my_team_players TO authenticated USING(owner_id=auth.uid()) WITH CHECK(owner_id=auth.uid());
    GRANT USAGE ON SCHEMA public,auth TO authenticated,anon;
    GRANT SELECT,INSERT,UPDATE ON public.my_teams,public.my_players,public.my_team_players TO authenticated;
  `);
  await db.exec(sql);
});
after(async()=>{await db?.close()});
async function asOwner(id=owner){await db.exec(`RESET ROLE; SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','${id}',false);`)}
async function call(id,teamId=team,name='שחקן בדיקה',note=null){
  return db.query('SELECT public.create_player_with_team($1,$2,$3,$4) AS player_id',[id,teamId,name,note]);
}
async function counts(id){
  await db.exec('RESET ROLE');
  const result=await db.query('SELECT (SELECT count(*)::int FROM my_players WHERE id=$1) AS players,(SELECT count(*)::int FROM my_team_players WHERE player_id=$1) AS memberships',[id]);
  return result.rows[0];
}

test('SQL installs as SECURITY INVOKER with a fixed empty search_path',async()=>{
  const {rows}=await db.query("SELECT prosecdef,proconfig FROM pg_proc WHERE oid='public.create_player_with_team(uuid,uuid,text,text)'::regprocedure");
  assert.equal(rows[0].prosecdef,false);assert.ok(rows[0].proconfig.some(v=>v.startsWith('search_path=')));
});
test('RPC creates a player and membership and derives ownership from auth.uid()',async()=>{
  const id='20000000-0000-4000-8000-000000000001';
  await asOwner();await call(id);
  assert.deepEqual(await counts(id),{players:1,memberships:1});
  const {rows}=await db.query('SELECT owner_id FROM my_players WHERE id=$1',[id]);assert.equal(rows[0].owner_id,owner);
});
test('membership failure rolls back the player insert in the same transaction',async()=>{
  const id='20000000-0000-4000-8000-000000000002';
  await asOwner();await assert.rejects(call(id,rejectedTeam),/check constraint/);
  assert.deepEqual(await counts(id),{players:0,memberships:0});
});
test('retry after lost response returns the same player with no duplicate membership',async()=>{
  const id='20000000-0000-4000-8000-000000000003';
  await asOwner();await call(id);await call(id);await call(id);
  assert.deepEqual(await counts(id),{players:1,memberships:1});
});
test('reusing the request ID with changed details is rejected without mutation',async()=>{
  const id='20000000-0000-4000-8000-000000000004';
  await asOwner();await call(id);await assert.rejects(call(id,team,'different'),/different player details/);
  assert.deepEqual(await counts(id),{players:1,memberships:1});
});
test('another owner cannot create a player in the first owner team',async()=>{
  const id='20000000-0000-4000-8000-000000000005';
  await asOwner(other);await assert.rejects(call(id),/Team unavailable/);
  assert.deepEqual(await counts(id),{players:0,memberships:0});
});
test('a request ID belonging to another owner cannot be reused or linked',async()=>{
  const id='20000000-0000-4000-8000-000000000006';
  await asOwner();await call(id);
  await asOwner(other);await assert.rejects(call(id,otherTeam),/Player unavailable|row-level security/);
  assert.deepEqual(await counts(id),{players:1,memberships:1});
});
test('anonymous role cannot execute the function',async()=>{
  await db.exec("RESET ROLE; SET ROLE anon; SELECT set_config('request.jwt.claim.sub','',false)");
  await assert.rejects(call('20000000-0000-4000-8000-000000000007'),/permission denied/);
});
test('authenticated role with no user claim cannot create records',async()=>{
  const id='20000000-0000-4000-8000-000000000008';
  await asOwner('');await assert.rejects(call(id),/Authentication required/);
  assert.deepEqual(await counts(id),{players:0,memberships:0});
});
