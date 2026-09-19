-- meta 'priority_locations': from rules to the list the person typed.
--
-- The places someone wants searched first were stored as the rules the page
-- computed from what they typed - `[{label, allOf?, anyOf?}, ...]` - so the one
-- list they wrote existed only as a by-product of matching logic. The location
-- settings (docs/location-settings-plan.md) store every place list as typed:
-- a comma-separated string, one `meta` value, read by the prompt as written and
-- turned into rules by the page when it loads. Nothing stores rules any more.
--
-- Each stored rule array becomes its labels, in their order, joined with ", " -
-- the label is what the person typed for each place, so that is their list
-- back. A rule with no text label contributes nothing; an empty or label-less
-- array becomes ''. A value that isn't a JSON array is left alone: it is
-- already text.
--
-- The labels are gathered by a subquery ordered by array position before they
-- are joined, which is what keeps the person's ranking.
--
-- Only this key changes. The new keys - search_locations, excluded_locations,
-- location_note - start unset, which reads as ''. An intake's stored answers
-- keep their rules: they are the record of what was sent.

UPDATE meta
   SET value = COALESCE(
         (SELECT group_concat(label, ', ')
            FROM (SELECT trim(json_extract(item.value, '$.label')) AS label
                    FROM json_each(meta.value) AS item
                   WHERE json_type(item.value, '$.label') = 'text'
                     AND trim(json_extract(item.value, '$.label')) <> ''
                   ORDER BY item.key)),
         '')
 WHERE key = 'priority_locations'
   AND json_valid(value)
   AND json_type(value) = 'array';
