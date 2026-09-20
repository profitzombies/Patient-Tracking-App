-- Provider inserts invoke this trigger internally; browser roles must not
-- receive an executable SECURITY DEFINER entry point.
revoke all on function public.initialize_practice_launch() from public, anon, authenticated;