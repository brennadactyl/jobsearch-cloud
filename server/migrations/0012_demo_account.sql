-- A demo account is marked, and its invented companies leave the one list.
--
-- 0011_one_company_list.sql merged every account's rotation into
-- company_fetch, the list every search indexes into, without asking whose
-- rotation a company came from. One account's rotation is not a job search:
-- the demo account (scripts/seed-demo-user.ps1) is filled from
-- scripts/demo-user.json, whose companies are invented - Northwind Systems,
-- Kestrel Analytics and nineteen more. On the deployment this was written
-- against, 0011 put all 21 on the list, taking it from 139 real companies to
-- 160, and the first searches afterwards were handed them like any other: SWE's
-- run met 8 in its first 48, searched the web for each, and noted that no such
-- company could be identified.
--
-- ---- users.demo
--
-- Nothing stopped it because the server could not tell a demo account from a
-- person. The name is not a way to - "Demo" can be handed to a real person, as
-- seed-demo-user.ps1 warns - so the account is marked:
--
--   0  a person. The default, and every account created without saying.
--   1  a demo account, whose data is invented by definition. POST /api/coverage
--      refuses it (src/routes/coverage.js): company_fetch is the one table every
--      account shares, and that route is the only thing that writes it. The
--      account still reads the list.
--
-- Set by whoever provisions the account - POST /api/users takes `demo`, and
-- seed-demo-user.ps1 passes it - and backfilled here with the test that
-- seed-demo-user.ps1's -Force and backup-tracker.ps1 already rely on: named
-- Demo, holding at least one lead, and every posting URL the account holds -
-- leads, screened, application links - on example.com or a subdomain of it,
-- which IANA reserves and no real job board uses. One URL anywhere else and the
-- account is a person, whatever it is called.
--
-- ---- The removal
--
-- By exact key, not by pattern: the 21 companies scripts/demo-user.json's
-- coverage block named, as src/exclude.js's normalize() keys them. And only
-- where a demo account holds a sweep row for the key, so a deployment with no
-- demo account, or one whose demo was never seeded, loses nothing - even if a
-- real company there happens to share one of these names.
--
-- Removed from company_fetch, and from every account's company_sweeps rather
-- than only the demo's. A real account's row for one of these exists because
-- the list served the company to that account's search, and its note is about a
-- company that does not exist. The demo account's own leads, screened rows and
-- applications are its data and are not touched.
--
-- Positions and cursors are deliberately left as they are. A cursor is compared
-- against `position`, never used as an index, and a slice steps over positions
-- nobody holds exactly as it steps over an excluded company. A removed company
-- behind a search's cursor changes nothing that search is served next; one
-- ahead of it is simply not served when its turn comes. Renumbering the list to
-- close the gaps is the one version of this that moves companies under every
-- cursor, and a search would then skip or repeat whatever stretch moved.
--
-- The seed no longer posts coverage and demo-user.json no longer carries it,
-- so re-seeding cannot bring these back by that path either.

ALTER TABLE users ADD COLUMN demo INTEGER NOT NULL DEFAULT 0;

-- Every posting URL each account holds, with its host. Scratch, dropped below.
CREATE TABLE demo_account_urls AS
  SELECT user_id, u,
         lower(CASE WHEN instr(substr(u, instr(u, '://') + 3), '/') > 0
                    THEN substr(substr(u, instr(u, '://') + 3), 1, instr(substr(u, instr(u, '://') + 3), '/') - 1)
                    ELSE substr(u, instr(u, '://') + 3) END) AS host
    FROM (SELECT user_id, url AS u FROM leads
          UNION ALL SELECT user_id, url FROM screened
          UNION ALL SELECT user_id, link FROM applications WHERE link <> '');

UPDATE users SET demo = 1
 WHERE name = 'Demo'
   AND EXISTS (SELECT 1 FROM leads WHERE leads.user_id = users.id)
   AND NOT EXISTS (
     SELECT 1 FROM demo_account_urls d
      WHERE d.user_id = users.id
        AND NOT ((d.u LIKE 'http://%' OR d.u LIKE 'https://%')
                 AND (d.host = 'example.com' OR d.host LIKE '%.example.com'))
   );

DROP TABLE demo_account_urls;

-- The keys to remove: demo-user.json's 21, where a demo account holds them.
CREATE TABLE demo_invented_companies AS
  SELECT DISTINCT s.company_key AS k
    FROM company_sweeps s JOIN users u ON u.id = s.user_id
   WHERE u.demo = 1
     AND s.company_key IN (
       'arcadia grid', 'bellwether health', 'cobalt interactive', 'driftwood studios',
       'fernbrook robotics', 'harborline software', 'ironvale retail', 'kestrel analytics',
       'lumenwave', 'marrowstone bio', 'meridian freight', 'northwind systems',
       'oakmoss design', 'pinehurst cloud', 'quillfeather ai', 'sandbar metrics',
       'silverpine media', 'thornfield energy', 'tidepool games', 'vantage labs',
       'wavelet labs'
     );

DELETE FROM company_fetch WHERE company_key IN (SELECT k FROM demo_invented_companies);
DELETE FROM company_sweeps WHERE company_key IN (SELECT k FROM demo_invented_companies);

DROP TABLE demo_invented_companies;
