-- Owner risk acceptance as a permission basis for Apify actors (ADR-043).
--
-- The product owner may run an actor on a site whose terms do not permit it,
-- accepting the legal risk, rather than recording a permission that does not
-- exist. Only admins record it; it lapses after at most 90 days (enforced by
-- source-policy-2); it is kept in the review history and the audit chain.

alter table source_registry drop constraint if exists source_registry_permission_basis_check;
alter table source_registry add constraint source_registry_permission_basis_check
  check (permission_basis in ('none', 'public_search_index', 'official_api_terms', 'written_permission', 'provider_contract', 'owner_risk_acceptance'));
