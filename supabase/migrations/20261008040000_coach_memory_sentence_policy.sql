-- Additive sentence-level ordinary preference policy. Existing pending rows
-- remain patient-controlled; this applies only to future extraction/correction.
create or replace function private.coach_memory_ordinary(p_category text,p_text text)
returns boolean language sql immutable set search_path='' as $$
  select (p_category='food_preference' and p_text ~* '^(i )?(really )?(like|love|prefer|enjoy|hate|dislike|avoid) (chicken|turkey|fish|salmon|eggs?|yogurt|fruit|vegetables?|salad|rice|beans?|oatmeal|coffee|tea|water|((vegetarian|vegan|quick|simple) (meals?|recipes?)))( (for|at) (breakfast|lunch|dinner|snacks?))?[.!]?$')
      or (p_category='routine' and p_text ~* '^(i )?(usually|always|often) (eat|have|cook|drink) (breakfast|lunch|dinner|water|coffee|tea)( at [0-9]{1,2}(:[0-9]{2})? (am|pm))?[.!]?$')
      or (p_category='coaching_preference' and p_text ~* '^(please )?(give|keep|make) (me )?(short|brief|simple|step-by-step|gentle) (answers?|guidance|instructions?)[.!]?$')
$$;