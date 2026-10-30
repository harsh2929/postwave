export interface DomCounters {
  documents: number;
  nodes: number;
  jsEventListeners: number;
}

export interface CdpSessionLike {
  send(method: string): Promise<unknown>;
}

export function collectGarbageCollectedDomCounters(
  session: CdpSessionLike,
): Promise<DomCounters>;
