// apps/web/src/lib/api.ts — typed REST + SSE client over the NestJS backend.
// All requests hit the "/api" prefix (proxied to http://localhost:3001 in dev).
import type {
  Game,
  EngineEval,
  MoveEval,
  ImportGameRequest,
  AnalyzePositionRequest,
  AnalyzeGameRequest,
  AgentMessageRequest,
  AgentEvent,
  Collection,
  GameSummary,
  LibraryPage,
  LibraryQuery,
  CatalogEntry,
  StartImportRequest,
  ImportJob,
  ImportEvent,
} from "@chess/shared";

const BASE = "/api";

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const message = await extractError(res);
    throw new ApiError(res.status, message);
  }
  // 204 / empty bodies (e.g. DELETE) have nothing to parse.
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

async function extractError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string | string[] };
    if (Array.isArray(body.message)) return body.message.join(", ");
    if (body.message) return body.message;
  } catch {
    // fall through to status text
  }
  return res.statusText || `Request failed (${res.status})`;
}

export function importGame(body: ImportGameRequest): Promise<Game> {
  return request<Game>("/games", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function getGame(id: string): Promise<Game> {
  return request<Game>(`/games/${encodeURIComponent(id)}`);
}

export function analyzePosition(
  body: AnalyzePositionRequest,
): Promise<EngineEval> {
  return request<EngineEval>("/analysis/position", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function analyzeGame(body: AnalyzeGameRequest): Promise<MoveEval[]> {
  return request<MoveEval[]>("/analysis/game", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Serialize a {@link LibraryQuery} into a `?key=value` string, dropping empties. */
function libraryQueryString(query: LibraryQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/** Search/sort/paginate the game library. */
export function searchLibrary(query: LibraryQuery = {}): Promise<LibraryPage> {
  return request<LibraryPage>(`/library/games${libraryQueryString(query)}`);
}

/** Fetch the full stored game (loaded into the analysis view on row click). */
export function getLibraryGame(id: string): Promise<Game> {
  return request<Game>(`/library/games/${encodeURIComponent(id)}`);
}

/** Delete a stored game from the library. */
export function deleteLibraryGame(id: string): Promise<void> {
  return request<void>(`/library/games/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/** List all collections (with their game counts). */
export function listCollections(): Promise<Collection[]> {
  return request<Collection[]>("/library/collections");
}

/** Fetch a collection and the games it contains. */
export function getCollection(
  id: string,
): Promise<{ collection: Collection; games: GameSummary[] }> {
  return request<{ collection: Collection; games: GameSummary[] }>(
    `/library/collections/${encodeURIComponent(id)}`,
  );
}

/** Delete a collection and cascade-delete its games. */
export function deleteCollection(id: string): Promise<void> {
  return request<void>(`/library/collections/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/** The curated bulk-download catalog (remote/bundled PGNs). */
export function getImportCatalog(): Promise<CatalogEntry[]> {
  return request<CatalogEntry[]>("/import/catalog");
}

/** Start a bulk-import job; returns the new job id to stream/poll. */
export function startImport(
  body: StartImportRequest,
): Promise<{ jobId: string }> {
  return request<{ jobId: string }>("/import", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Fetch the current state of an import job (poll fallback for the SSE stream). */
export function getImportJob(jobId: string): Promise<ImportJob> {
  return request<ImportJob>(`/import/${encodeURIComponent(jobId)}`);
}

/**
 * Opens an SSE stream of {@link ImportEvent}s for a running import job. The
 * caller owns the returned {@link EventSource} and must `.close()` it (the
 * server completes the stream on `done`/`error`, but the client still closes).
 */
export function openImportStream(
  jobId: string,
  onEvent: (e: ImportEvent) => void,
): EventSource {
  const source = new EventSource(
    `${BASE}/import/${encodeURIComponent(jobId)}/stream`,
  );
  source.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data) as ImportEvent);
    } catch {
      // ignore malformed frames; the server controls the wire format
    }
  };
  return source;
}

export async function sendAgentMessage(
  sessionId: string,
  body: AgentMessageRequest,
): Promise<void> {
  await request<unknown>(
    `/agent/${encodeURIComponent(sessionId)}/messages`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
}

/**
 * Opens a persistent SSE stream of {@link AgentEvent}s for a chat session.
 * The caller owns the returned {@link EventSource} and must `.close()` it.
 */
export function openAgentStream(
  sessionId: string,
  onEvent: (e: AgentEvent) => void,
): EventSource {
  const source = new EventSource(
    `${BASE}/agent/${encodeURIComponent(sessionId)}/stream`,
  );
  source.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data) as AgentEvent);
    } catch {
      // ignore malformed frames; the server controls the wire format
    }
  };
  return source;
}

export { ApiError };
