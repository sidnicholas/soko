# ADR-045: Approval-first email outreach

- Status: Accepted
- Date: 2026-10-17
- PRD v2 FR-07 (P2 slice 2); builds on ADR-041 (consent), ADR-032 (channels)

## Context

The P1 gate passed. P2 slice 2 is the first outbound channel: email to the
sellers and buyers behind Action Queue candidates. Most first contacts are
cold (people found in listings and wanted posts). The PRD requires human
approval for first outreach, opt-out, sender identity, channel consent,
frequency caps, quiet hours, CAN-SPAM, reply classification and threading,
and one operator inbox.

Provider (product owner, 2026-10-17): a Hostinger mailbox on a separate
sending domain. Transactional services (Postmark) forbid cold email and
marketing platforms (Brevo) require opt-in lists; a real mailbox with SMTP
and IMAP fits low-volume one-to-one mail and gives replies in a real inbox.

## Decision

- **Tables** (migration 0036): `conversations` (one per contact address and
  topic, optionally about a lead, candidate or deal) and
  `conversation_messages` (outbound and inbound), `outreach_mailbox_state`
  (IMAP position). All hang off `counterparties` and are deleted with it.
- **Approval-first.** Staff write drafts (`outcome:record`). A person with
  the new `outreach:send` permission (operators, admins; never agents)
  approves a draft by quoting the SHA-256 of recipient, subject and body as
  shown; if the draft changed, nothing is approved. Every message is
  approved; follow-ups and replies too. Graduating to grants (PRD:
  conditional follow-up) is later.
- **Gate**, at approval and again at send: recorded email consent for
  outreach in force (`public_business_contact` covers a business address the
  party published, as on their own listing), the address on the contact and
  `active` (not bounced or invalid), not in `contact_suppressions`.
- **Sending.** Approved = `queued`. The API tries to send at once; the
  `worker-lifecycle` sweep (every 15 min) sends the rest. Each message is
  claimed (`sending`, Message-ID assigned) under an advisory lock before the
  SMTP call, so it is sent at most once: a crash mid-send leaves it `sending`
  and after 15 minutes it is an exception the operator resolves after
  checking the Sent folder. A refused send is `failed` and is not retried.
  Limits: `OUTREACH_DAILY_CAP` per rolling 24 h (default 20, for mailbox
  warm-up), `OUTREACH_MIN_GAP_HOURS` between messages to one contact unless
  they replied (default 72), sending hours `OUTREACH_SEND_HOURS` in
  `OUTREACH_TIMEZONE` on weekdays (quiet hours). A copy is filed in the
  mailbox's Sent folder over IMAP.
- **Every message** carries the sender's name, `OUTREACH_POSTAL_ADDRESS`
  and an unsubscribe link, plus `List-Unsubscribe` (link and mailto) and
  `List-Unsubscribe-Post` one-click headers (RFC 8058). Sending stays off
  until the mailbox, password, postal address and `PUBLIC_API_BASE_URL` are
  set. The link is an HMAC-signed token naming the sent message; opening it
  shows a confirm button (link scanners do not unsubscribe anyone), the POST
  records the opt-out.
- **Replies.** Each sweep reads new INBOX mail over IMAP (UID position;
  14 days back on first run or a UID validity change). A message is filed
  in a conversation by In-Reply-To/References (bounces: our Message-ID quoted
  in the body), else the sender's latest conversation; other mail is left
  alone and not stored. Classified without a model: `bounce` (address marked
  bounced), `auto_reply` (filed as read), `opt_out` (words such as
  unsubscribe, remove me, stop; opt-out recorded) and `reply`. Opt-outs and
  bounces cancel everything still queued to that contact. Inbound text is
  data: instruction-like content is flagged, never acted on.
- **Events** `outreach.scheduled.v1`, `outreach.sent.v1`,
  `outreach.reply_received.v1` and hash-chained audit entries, with ids and
  classifications only, never addresses or text.
- **UI.** Outreach Inbox (`/outreach`): needs review, drafts, exceptions,
  queued, awaiting response, and the sending status. Conversation page:
  thread, draft editing, "Approve and send", reply. Contact page: Email card
  (conversations, new email, why the contact cannot be emailed).

## Consequences

- No message leaves without a person approving its exact text to its exact
  recipient, and consent is re-checked at the moment of sending.
- Deliverability depends on the mailbox's SPF/DKIM/DMARC and warm-up; the
  cap is the safety valve. Hostinger's own sending limits apply on top.
- Classification is keyword-based; an unusual opt-out phrasing lands in
  "needs review", where the operator records it on the Consent card.
- Commitment detection, model-drafted messages, sequences and delegated
  follow-ups are not in this slice.
