-- tracks.pay_floor and tracks.pay_floor_unit: the lowest pay worth showing,
-- in the person's own words (docs/search-fields-plan.md).
--
-- A search's pay rule could only be written as prose before this, in
-- fit_clause, fit_disqualifier or fit_filter_step. Prose freezes the rule as
-- it was worded the day it was written: a change to how the rule should read
-- reaches the accounts someone edits afterwards and no others, silently. The
-- amount is what the person decides; the wording around it is the prompt's,
-- composed every run from these two columns (src/prompt.js), so a change to
-- that wording reaches every account on its next run with nothing to re-save.
--
--   pay_floor       the amount as typed, trimmed at the ends, '' when unset.
--                   Nothing parses a number out of it and nothing rewrites it,
--                   so "180k", "$180,000" and "£140,000" are all kept as
--                   written - and the last of those says its own currency,
--                   which is why there is no currency column.
--   pay_floor_unit  'year' or 'hour', '' when no floor is set. The one part
--                   that must be machine-readable, so it comes from a select
--                   rather than the text.
--
-- The two are set together and cleared together: a unit with no amount says
-- nothing, and an amount with no unit can't be stated. Every existing track
-- starts with no floor, and a search whose pay rule is already typed into its
-- prose keeps it, untouched, until someone sets a floor in the panel.

ALTER TABLE tracks ADD COLUMN pay_floor TEXT NOT NULL DEFAULT '';
ALTER TABLE tracks ADD COLUMN pay_floor_unit TEXT NOT NULL DEFAULT '';
