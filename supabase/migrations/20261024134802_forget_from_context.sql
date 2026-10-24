-- "I was just testing" / "ignore that": the messages stay in the chat for the
-- user but leave the agent's context, and what was learned from them is unlearned.
alter table public.chat_messages
  add column if not exists excluded_from_context boolean not null default false;

alter table public.interests
  add column if not exists source_message_id uuid references public.chat_messages(id) on delete set null;

create index if not exists interests_source_message_idx on public.interests (source_message_id)
  where source_message_id is not null;
