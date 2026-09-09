begin;

create or replace function public.food_catalog_variant_explicit_constraints_match(
  p_query text,p_dimensions jsonb,p_summary text
)returns boolean language plpgsql immutable strict parallel safe as $$
declare
  ratio_lean text;
  ratio_fat text;
  preparation text:=lower(coalesce(p_dimensions->>'preparation','')||' '||coalesce(p_summary,''));
  requested text;
begin
  ratio_lean:=substring(p_query from '([0-9]{2})%');
  if ratio_lean is null then ratio_lean:=substring(p_query from '([0-9]{2})/[0-9]{1,2}');end if;
  ratio_fat:=substring(p_query from '[0-9]{2}/([0-9]{1,2})');
  if ratio_lean is not null then
    if not coalesce(p_dimensions->>'leanness'like ratio_lean||'% lean%',false)then return false;end if;
    if ratio_fat is not null and not coalesce(
      p_dimensions->>'leanness'like'%/ '||ratio_fat||'% fat',false
    )then return false;end if;
  end if;
  foreach requested in array array['raw','cooked','grilled','fried','roasted','baked',
    'broiled','boiled','poached','steamed','canned','frozen','dry']
  loop
    if p_query~(('(^| )'||requested||'( |$)'))then
      if requested='raw'and p_dimensions->>'state'<>'raw'then return false;
      elsif requested='cooked'and p_dimensions->>'state'<>'cooked'then return false;
      elsif requested='canned'and not(p_dimensions->>'state'='prepared'and preparation~'\mcanned\M')then return false;
      elsif requested='frozen'and not(lower(coalesce(p_dimensions->>'form','')||' '||p_summary)~'\mfrozen\M')then return false;
      elsif requested='dry'and not(p_dimensions->>'state'='dry'or preparation~'\mdry\M')then return false;
      elsif requested not in('raw','cooked','canned','frozen','dry')
        and preparation!~(('(^|[^a-z])'||requested||'([^a-z]|$)'))then return false;
      end if;
    end if;
  end loop;
  return true;
end;
$$;
revoke all on function public.food_catalog_variant_explicit_constraints_match(text,jsonb,text)
  from public,anon,authenticated;
grant execute on function public.food_catalog_variant_explicit_constraints_match(text,jsonb,text)
  to service_role;
notify pgrst,'reload schema';
commit;