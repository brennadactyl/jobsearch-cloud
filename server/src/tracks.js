/**
 * Feed groups (docs/glossary.md#searches-and-tracks).
 *
 * A track with `fed_by` set is a tab that another track's search fills. The
 * track that runs the search is the group's root, and the root plus every
 * track fed by it is one feed group: one search, several tabs. `fed_by` is one
 * level - a fed track is a tab, not a search - so the root is always one hop
 * away and no chain is ever followed.
 *
 * Every rule that asks "which search fills this tab" or "which tabs does this
 * search fill" reads it from here, so the answer can't differ between dedup,
 * screening, run records and prompts.
 */

/**
 * The key of the track whose search fills this track's tab.
 * @param {{key: string, fed_by?: string}} track
 * @returns {string}
 */
export function searchRootOf(track) {
  return track.fed_by || track.key;
}

/**
 * The root for a key, looked up in the person's tracks. A key no track has is
 * its own root, so a caller holding an unconfigured key still gets a usable
 * answer rather than nothing.
 * @param {Array<{key: string, fed_by?: string}>} tracks
 * @param {string} key
 * @returns {string}
 */
export function searchRootKey(tracks, key) {
  const track = tracks.find((t) => t.key === key);
  return track ? searchRootOf(track) : key;
}

/**
 * The tracks a root's search fills besides its own tab.
 * @template {{key: string, fed_by?: string}} T
 * @param {T[]} tracks
 * @param {string} rootKey
 * @returns {T[]}
 */
export function tracksFedBy(tracks, rootKey) {
  return tracks.filter((t) => t.fed_by === rootKey);
}

/**
 * Every key in a root's feed group: the root first, then the tabs it fills.
 * @param {Array<{key: string, fed_by?: string}>} tracks
 * @param {string} rootKey
 * @returns {string[]}
 */
export function feedGroupKeys(tracks, rootKey) {
  return [rootKey, ...tracksFedBy(tracks, rootKey).map((t) => t.key)];
}
