-- Where a supply listing lives and who is selling it. Connectors already read
-- both from the marketplace APIs (eBay itemWebUrl and seller, Reverb's web link
-- and shop) but nothing stored them, so an opportunity could show its economics
-- and scores but not the listing, the seller or where the item is.
--
-- location (GeoLocation shape) and condition_json already exist and are now
-- filled too. Rows ingested before this keep nulls until the next sweep sees
-- them again. supply already has row level security (0022).
alter table supply add column if not exists listing_url text;
alter table supply add column if not exists seller_json jsonb;
