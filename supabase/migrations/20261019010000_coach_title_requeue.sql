-- Re-queue title work for conversations that only ever received one of the
-- old allowlisted generic labels, so the title job (now model-written from
-- the first message) names them. Patient-chosen names are never touched.
update public.coach_conversation_work w
set state = 'pending', lease_owner = null, lease_until = null, last_error = null, updated_at = now()
from public.patient_chat_conversations c
where w.conversation_id = c.id and w.kind = 'title' and w.state = 'ready'
  and c.thread = 'coach' and c.archived_at is null and c.title_source = 'system'
  and c.title in ('New conversation', 'Coach conversation', 'Meal ideas', 'Grocery planning', 'Snack support', 'Coaching plan');
