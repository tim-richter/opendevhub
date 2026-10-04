import type { ForgeKind } from "../shared/types";
import type { ForgeStore } from "./config";
import { type Forge, type RemoteInfo, resolveForge } from "./forge";

const PROBE_TIMEOUT_MS = 3000;

async function answers(url: string, fetchImpl: typeof fetch): Promise<boolean> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: abort.signal, headers: { accept: "application/json" } });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => undefined)) as { version?: unknown } | undefined;
    return typeof body?.version === "string";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** One unauthenticated look at a host's API: Forgejo first, then Gitea. */
export async function probeForge(web: string, fetchImpl: typeof fetch = fetch): Promise<ForgeKind> {
  const base = web.replace(/\/$/, "");
  if (await answers(`${base}/api/forgejo/v1/version`, fetchImpl)) return "forgejo";
  if (await answers(`${base}/api/v1/version`, fetchImpl)) return "gitea";
  return "unknown";
}

/** The forge for a remote; a host nobody configured is probed once and the answer (even "unknown") remembered. */
export async function detectForge(remote: RemoteInfo | undefined, store: ForgeStore, fetchImpl: typeof fetch = fetch): Promise<Forge> {
  const known = resolveForge(remote, store.all());
  if (known) return known;
  if (!remote || !remote.host.includes(".")) return { kind: "unknown" };
  const kind = await probeForge(remote.web, fetchImpl);
  store.remember(remote.host, { kind });
  return resolveForge(remote, store.all()) ?? { kind: "unknown" };
}
