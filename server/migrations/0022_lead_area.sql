-- leads.area and applications.area: which of the person's ranked places a
-- posting falls in (docs/location-settings-plan.md, "Each lead carries its area").
--
-- The page used to tier a lead by matching its location against rules - terms
-- under each ranked place - and a list typed as plain places can't carry those
-- terms: "Seattle area" said nothing about Kirkland. So the nightly search, which
-- already judges whether a location fits, names the ranked place it belongs to,
-- and the page tiers by that.
--
--   area  an entry of the person's `priority_locations`, exactly as typed, or ''
--         for none. A lead keeps its real `location` beside it.
--
-- Only a ranked entry is stored: the leads route, and the overnight fill for
-- applications added by hand, keep an area that names one entry of the list -
-- split on commas and trimmed, compared ignoring case - storing the entry as the
-- person spelled it, and store '' for anything else, so a near-miss
-- can't pass for a tier it doesn't name (validate.js storedArea). An
-- application made from a lead copies the lead's area.
--
-- Existing rows start at ''. They get their areas from a one-time fill that
-- runs the page's own matcher over the rules each account had, so every lead
-- lands in the tier it was in before.

ALTER TABLE leads ADD COLUMN area TEXT NOT NULL DEFAULT '';
ALTER TABLE applications ADD COLUMN area TEXT NOT NULL DEFAULT '';
