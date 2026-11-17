-- REVIEW ONLY: do not execute on Supabase without explicit owner approval.
-- Prerequisites: public.my_teams / my_players / my_team_players, UUID IDs and
-- owner_id, existing owner_only RLS policies and ownership composite FKs.
-- This transaction creates one SECURITY INVOKER function; it does not change
-- existing rows, table definitions, constraints or RLS policies.
BEGIN;

-- Fail before installation if the assumed ID types or RLS differ from the
-- expected schema. Names/text columns are checked when the function is used.
DO $check$
DECLARE
  v_table text;
  v_column text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['my_teams','my_players','my_team_players'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=v_table AND c.relrowsecurity
    ) THEN
      RAISE EXCEPTION 'Missing table or disabled RLS: %',v_table;
    END IF;
    FOREACH v_column IN ARRAY CASE WHEN v_table='my_team_players'
      THEN ARRAY['owner_id','team_id','player_id'] ELSE ARRAY['id','owner_id'] END LOOP
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name=v_table
          AND column_name=v_column AND udt_name='uuid'
      ) THEN
        RAISE EXCEPTION 'Expected UUID column %.%',v_table,v_column;
      END IF;
    END LOOP;
  END LOOP;
END;
$check$;

-- Deliberately CREATE, not CREATE OR REPLACE: an existing function must be
-- reviewed rather than overwritten. A failed installation rolls back in full.
CREATE FUNCTION public.create_player_with_team(
  p_player_id uuid,
  p_team_id uuid,
  p_full_name text,
  p_age_note text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_owner uuid := auth.uid();
  v_player public.my_players%ROWTYPE;
  v_name text := pg_catalog.btrim(p_full_name);
  v_note text := NULLIF(pg_catalog.btrim(p_age_note),'');
BEGIN
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501';
  END IF;
  IF p_player_id IS NULL OR p_team_id IS NULL OR v_name IS NULL OR v_name='' THEN
    RAISE EXCEPTION 'Player ID, team and name are required' USING ERRCODE='22023';
  END IF;
  -- Never accept an owner ID from the client. RLS remains in effect throughout.
  PERFORM 1 FROM public.my_teams WHERE id=p_team_id AND owner_id=v_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Team unavailable' USING ERRCODE='42501';
  END IF;

  INSERT INTO public.my_players(id,owner_id,full_name,age_note)
    VALUES(p_player_id,v_owner,v_name,v_note)
    ON CONFLICT(id) DO NOTHING;

  -- Row lock serializes retries of the same request, including concurrent calls.
  SELECT * INTO v_player FROM public.my_players
    WHERE id=p_player_id AND owner_id=v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Player unavailable' USING ERRCODE='42501';
  END IF;
  IF v_player.full_name IS DISTINCT FROM v_name OR v_player.age_note IS DISTINCT FROM v_note THEN
    RAISE EXCEPTION 'Request ID already used with different player details' USING ERRCODE='22023';
  END IF;
  -- A request ID represents exactly one player-and-team creation operation.
  IF EXISTS(SELECT 1 FROM public.my_team_players
    WHERE player_id=p_player_id AND owner_id=v_owner AND team_id<>p_team_id) THEN
    RAISE EXCEPTION 'Request ID already used with another team' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.my_team_players(owner_id,team_id,player_id)
    SELECT v_owner,p_team_id,p_player_id
    WHERE NOT EXISTS(SELECT 1 FROM public.my_team_players
      WHERE owner_id=v_owner AND team_id=p_team_id AND player_id=p_player_id);
  -- Any error, including membership constraints/RLS, rolls back both inserts.
  RETURN p_player_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_player_with_team(uuid,uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_player_with_team(uuid,uuid,text,text) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_player_with_team(uuid,uuid,text,text) TO authenticated;
COMMIT;
