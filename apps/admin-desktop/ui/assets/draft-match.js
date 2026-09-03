// Whether a mod about to be added is already here - in the draft, or on the server outside
// the pack - and whether it is the same version. Matched by what a file is, never only by what
// it is called: the same mod's files carry the version in their names, so a name match alone
// cannot tell "the same" from "an older one", and an older one under another name used to go
// in beside the new as a second copy the check then refused to publish.

const lower = value => String(value || "").toLowerCase();

/**
 * The draft file this mod would stand next to, if any. Looked up by the catalog project it
 * came from, then by mod id, then by path. `same` says the draft already holds this very
 * version: the same bytes, the same catalog version, or the same declared version.
 */
export function findInDraft(files, { modIds = [], provider = null, projectId = null, versionId = null, version = null, path = null, sha256 = null } = {}) {
  const live = (files || []).filter(file => file && file.change !== "removed" && !file.serverRemoval);
  const ids = new Set((modIds || []).filter(Boolean));
  const file = live.find(f => provider && projectId && f.source?.provider === provider && String(f.source?.projectId) === String(projectId))
    || live.find(f => ids.size && (f.modIds || []).some(id => ids.has(id)))
    || live.find(f => path && lower(f.path) === lower(path))
    || null;
  if (!file) return null;
  const same = Boolean((sha256 && file.sha256 === sha256)
    || (versionId && file.source?.provider === provider && String(file.source?.versionId) === String(versionId))
    || (version && file.modVersion && file.modVersion === version));
  return { file, same };
}

/** A file on the server outside the pack that is the same mod, or null. Only mod ids can tell. */
export function findOnServer(serverFiles, { modIds = [] } = {}) {
  const ids = new Set((modIds || []).filter(Boolean));
  if (!ids.size) return null;
  return (serverFiles || []).find(file => file && (file.modIds || []).some(id => ids.has(id))) || null;
}

/**
 * The side a file keeps when the same bytes are already in the draft for another side. A
 * library one mod needs on the client and another on both sides has to be there for both;
 * narrowing it to the newcomer's side would take it away from the mod that had it first.
 */
export function sideAfter(existing, wanted) { return !existing || existing === wanted ? wanted : "both"; }

/** The path a new file takes the place of, or null when it simply updates its own path. */
export function replacementFor(match, path) {
  if (!match || match.same) return null;
  return lower(match.file.path) === lower(path) ? null : match.file.path;
}
