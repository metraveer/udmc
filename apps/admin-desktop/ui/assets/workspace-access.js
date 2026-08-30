import { t } from "./i18n.js";
export function createWorkspaceAccess({ request, getBinding, onConflict }) {
  let revision = null;
  let supported = false;
  let session = crypto.randomUUID();
  let status = null;
  let writing = false;

  function reset() {
    revision = null; supported = false; status = null; writing = false;
    session = crypto.randomUUID();
  }
  function receive(value) {
    supported = Boolean(value);
    status = value || null;
  }
  function acceptDraft(value) { revision = value || null; }
  function headers() { return { "x-udmc-session": session }; }
  async function mutate(path, options = {}, timeout) {
    if (writing) throw new Error(t("Дождитесь завершения предыдущей операции."));
    if (supported && !revision) throw new Error(t("Обновите состав сборки перед изменениями."));
    const binding = getBinding(), expected = revision;
    writing = true;
    try {
      const data = await request(path, { ...options, headers: { ...options.headers, ...headers(),
        ...(expected ? { "x-udmc-revision": expected } : {}) } }, timeout);
      if (binding === getBinding()) revision = data.workspaceRevision || revision;
      return data;
    } catch (error) {
      if (binding === getBinding() && (error.outcomeUnknown || [409, 423, 428].includes(error.status))) {
        revision = null;
        if (error.workspace) receive(error.workspace);
        onConflict(error);
      }
      throw error;
    } finally { if (binding === getBinding()) writing = false; }
  }
  async function heartbeat() {
    if (!supported) return;
    const binding = getBinding();
    const result = await request("/admin/workspace/heartbeat", { method: "POST", headers: headers() });
    if (binding === getBinding()) receive(result);
  }
  async function release() {
    if (!supported) return;
    const binding = getBinding();
    const result = await request("/admin/workspace/release", { method: "POST", headers: { ...headers(),
      ...(revision ? { "x-udmc-revision": revision } : {}) } });
    if (binding === getBinding()) receive(result);
  }
  return { reset, receive, acceptDraft, headers, mutate, heartbeat, release,
    revision: () => revision,
    changed: () => supported && revision !== null && status?.revision !== revision,
    status: () => status, locked: () => Boolean(status?.lease && !status.lease.mine) };
}
