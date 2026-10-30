// Names for '@<GUID>' mentions and titles for '#123' work items, looked up by the extension host
// (Azure DevOps REST, signed in). Results arrive asynchronously; views subscribe to re-render.
// Without a transport (headless tests) nothing is looked up.

export type LookupKind = 'identity' | 'workitem';

let transport: ((kind: LookupKind, key: string) => void) | undefined;
const results = new Map<string, string | null>();
const requested = new Set<string>();
const listeners = new Set<() => void>();

export function setLookupTransport(send: (kind: LookupKind, key: string) => void) {
  transport = send;
}

/// The looked-up text, or undefined while unknown (a request is sent once).
export function lookup(kind: LookupKind, key: string): string | null | undefined {
  const id = `${kind}:${key.toLowerCase()}`;
  if (results.has(id)) return results.get(id);
  if (transport && !requested.has(id)) {
    requested.add(id);
    transport(kind, key);
  }
  return undefined;
}

export function receiveLookup(kind: LookupKind, key: string, value: string | null) {
  results.set(`${kind}:${key.toLowerCase()}`, value);
  listeners.forEach(listener => listener());
}

/// After signing in: forget failed lookups so they are requested again.
export function retryLookups() {
  for (const [id, value] of results) if (value === null) { results.delete(id); requested.delete(id); }
  listeners.forEach(listener => listener());
}

export function onLookup(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
