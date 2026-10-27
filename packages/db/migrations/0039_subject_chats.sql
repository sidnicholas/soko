-- Opportunity assistant (ADR-048): a conversation on each intel candidate or
-- marketplace opportunity, with the model picked per message (Claude,
-- Perplexity, OpenAI). One thread per subject. Each assistant row keeps what
-- it cost, so the daily cap sums this table.

create table if not exists chat_messages (
  id            uuid primary key default gen_random_uuid(),
  subject_type  text not null check (subject_type in ('intel_candidate', 'opportunity')),
  subject_id    uuid not null,
  role          text not null check (role in ('user', 'assistant')),
  -- Which model answered (assistant rows only): claude, perplexity, openai.
  provider      text,
  model         text,
  content       text not null,
  -- Pages the answer cites: [{url, title?}]. Perplexity fills it.
  citations     jsonb not null default '[]'::jsonb,
  input_tokens  integer not null default 0,
  output_tokens integer not null default 0,
  cost_usd      numeric(10, 6) not null default 0,
  -- Set when the model call failed; the row says why and costs nothing.
  error         text,
  author_id     uuid,
  created_at    timestamptz not null default now()
);
create index if not exists chat_messages_subject_idx on chat_messages(subject_type, subject_id, created_at);
create index if not exists chat_messages_created_idx on chat_messages(created_at);
alter table chat_messages enable row level security;
