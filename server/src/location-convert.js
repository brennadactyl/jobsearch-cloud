/**
 * What converting the stored location lists would change - the rules, with no
 * D1 in sight.
 *
 * A location list is stored as its entries. A value written before that is a
 * comma-joined line, and every reader already reads one as the entries that
 * line splits into (./validate.js locationEntries), so nothing is broken by
 * leaving it. What converting buys is that reading stored values stops being
 * one of the comma rule's jobs: once no stored value needs it, its only caller
 * is the setup form, whose answers are prose.
 *
 * Which is why this is a conversion and never a repair. A line already means
 * the entries it splits into, so the entries are what gets stored, and what a
 * reader sees is the same on both sides. That property is worth checking, but
 * not here: comparing the entries to the entries they came from is comparing a
 * value to itself, which holds however wrong this file is. It is checked where
 * it can fail instead - through the read path, on a list served before and
 * after a conversion (`server/verify-local.mjs`).
 *
 * It cannot recover a place whose name held a comma. The split happened on the
 * way in and took the information with it, so "Vancouver, BC" is two entries
 * now and stays two - nothing here can tell a separator from part of a name,
 * and guessing would be the one way this could lose something. Those are
 * retyped by the person whose list it is.
 */
import { isStoredAsEntries, storedLocationList } from "./db.js";

/**
 * @typedef {Object} LocationRowPlan
 * @property {string} user_id
 * @property {string} key
 * @property {string} to the value to store
 */

/**
 * Which stored location lists are not yet entries, and what each becomes.
 * @param {{user_id: string, key: string, value: string}[]} rows as stored
 * @returns {{convert: LocationRowPlan[], alreadyEntries: number}}
 */
export function conversionPlan(rows) {
  /** @type {LocationRowPlan[]} */
  const convert = [];
  let alreadyEntries = 0;
  for (const row of rows) {
    if (isStoredAsEntries(row.value)) {
      alreadyEntries++;
      continue;
    }
    convert.push({
      user_id: row.user_id,
      key: row.key,
      to: JSON.stringify(storedLocationList(row.value)),
    });
  }
  return { convert, alreadyEntries };
}

/**
 * Write a plan, one row at a time, through whatever does the writing.
 *
 * The writing is the caller's because the account each row belongs to is what
 * scopes it, and this file has no business holding a database. It is a function
 * here rather than a loop in the handler so that what it writes can be checked
 * without one: on a deployment with nothing left to convert the loop never
 * runs, so a handler holding it is a loop no passing check reaches.
 * @param {{convert: LocationRowPlan[]}} plan
 * @param {(userId: string, key: string, value: string) => Promise<void>} write
 * @returns {Promise<number>} rows written
 */
export async function applyConversion(plan, write) {
  for (const row of plan.convert) {
    await write(row.user_id, row.key, row.to);
  }
  return plan.convert.length;
}

/**
 * How a plan is reported, with no account's places in it. An operator wants to
 * know how much is left to convert; the entries themselves are the person's,
 * and a count answers the question without putting one deployment's places in
 * a reply.
 * @param {{convert: LocationRowPlan[], alreadyEntries: number}} plan
 * @returns {{lists: number, accounts: number, alreadyEntries: number}}
 */
export function planSummary(plan) {
  return {
    lists: plan.convert.length,
    accounts: new Set(plan.convert.map((r) => r.user_id)).size,
    alreadyEntries: plan.alreadyEntries,
  };
}
