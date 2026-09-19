-- Retires the scope prose: the account settings that said, in sentences the
-- overnight run wrote, where a search may look.
--
-- Where a search looks is now the person's own three lists and note
-- (search_locations, excluded_locations, priority_locations, location_note;
-- docs/location-settings-plan.md), which the prompt reads every run. The prose
-- they replaced - geo_scope_line, scope_clause and scope_disqualifier, written by
-- the write-up - and location_guidance, the fixed advice on writing locations
-- that the prompt now states itself, are read by nothing and written by nothing
-- from this release on. An exclusion read as the scope once pointed a whole
-- search at the one state its person had ruled out; that class of mistake came
-- from scope being prose.
--
-- Each account's lists were drafted from its prose and approved before this ran,
-- and the backups taken before the deploy hold the prose as it was. Only these
-- four keys go; every other setting stays.

DELETE FROM meta
 WHERE key IN ('geo_scope_line', 'scope_clause', 'scope_disqualifier', 'location_guidance');
