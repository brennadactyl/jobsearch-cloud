-- Retires priority_rules, the ranking rules a few accounts kept while their
-- leads had no area.
--
-- The page tiers a lead by its area's place in the person's ranked list
-- (priority_locations; docs/location-settings-plan.md), and every account's
-- rows were given their area before this ran, each checked to keep the tier it
-- had. The rules were then cleared to [] account by account, so what this
-- removes is empty rows that nothing reads or writes from this release on.
--
-- Only this key goes; every other setting stays.

DELETE FROM meta WHERE key = 'priority_rules';
