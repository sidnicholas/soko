-- Email outreach: conversations and their messages (PRD v2 FR-07, P2 slice 2; ADR-045).
--
-- One mailbox sends and receives. An outbound message is a draft until a
-- person with outreach:send approves its exact wording to its recipient
-- (content_hash), then queued, claimed ('sending') and sent once; a message
-- left in 'sending' is never retried automatically. Replies are read over
-- IMAP and threaded by Message-ID / In-Reply-To, falling back to the
-- sender's address. Everything hangs off counterparties and is deleted with
-- the party (purge or deletion request).

create table if not exists conversations (
  id               uuid primary key default gen_random_uuid(),
  counterparty_id  uuid not null references counterparties(id) on delete cascade,
  channel          text not null default 'email' check (channel in ('email')),
  -- Normalized address of the contact for this conversation.
  their_address    text not null,
  subject          text not null,
  -- The deal this conversation is about, when there is one.
  subject_type     text check (subject_type in ('intel_lead', 'intel_candidate', 'opportunity', 'offnetwork_match')),
  subject_id       uuid,
  status           text not null default 'open' check (status in ('open', 'closed')),
  last_outbound_at timestamptz,
  last_inbound_at  timestamptz,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists conversations_party_idx on conversations(counterparty_id, created_at desc);
create index if not exists conversations_address_idx on conversations(their_address, updated_at desc);
alter table conversations enable row level security;

create table if not exists conversation_messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references conversations(id) on delete cascade,
  direction        text not null check (direction in ('outbound', 'inbound')),
  status           text not null check (status in ('draft', 'queued', 'sending', 'sent', 'failed', 'cancelled', 'received')),
  subject          text not null,
  body_text        text not null,
  -- sha256 of recipient, subject and body: what the approver saw is what is sent.
  content_hash     text,
  rfc_message_id   text unique,
  in_reply_to      text,
  from_address     text,
  to_address       text,
  -- Inbound: reply, opt_out, bounce, auto_reply.
  classification   text check (classification in ('reply', 'opt_out', 'bounce', 'auto_reply')),
  injection_flag   boolean not null default false,
  approved_by      uuid,
  approved_at      timestamptz,
  queued_at        timestamptz,
  sent_at          timestamptz,
  received_at      timestamptz,
  reviewed_at      timestamptz,
  reviewed_by      uuid,
  error            text,
  created_by       uuid,
  created_at       timestamptz not null default now()
);
create index if not exists conversation_messages_conv_idx on conversation_messages(conversation_id, created_at);
create index if not exists conversation_messages_status_idx on conversation_messages(status, queued_at);
create index if not exists conversation_messages_review_idx on conversation_messages(direction, reviewed_at) where direction = 'inbound';
alter table conversation_messages enable row level security;

-- IMAP position per mailbox folder, so each poll reads only new mail.
create table if not exists outreach_mailbox_state (
  mailbox          text primary key,
  uid_validity     bigint not null,
  last_uid         bigint not null default 0,
  polled_at        timestamptz not null default now()
);
alter table outreach_mailbox_state enable row level security;
