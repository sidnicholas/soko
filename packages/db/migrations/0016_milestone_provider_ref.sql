-- Wiring a real settlement provider surfaces a real bug: a rail that doesn't
-- support phased milestone capture on one reference (Stripe: a PaymentIntent
-- can only be captured once) was reusing the plan-level provider_ref across
-- every milestone, so a second milestone's release would fail against a real
-- provider. Milestones needing their own reference now get one, lazily.
alter table settlement_milestones add column if not exists provider_ref text;
