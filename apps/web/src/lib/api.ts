// apps/web/src/lib/api.ts — typed REST + SSE client over the NestJS backend.
// All requests hit the "/api" prefix (proxied to http://localhost:3001 in dev).
import type {
  EngineEval,
  MoveEval,
  ImportGameRequest,
  ImportGameResponse,
  AnalyzePositionRequest,
  AnalyzeGameRequest,
  AnalyzeGameStreamEvent,
  KeyMomentsRequest,
  AgentMessageRequest,
  AgentEvent,
  CatalogEntry,
  StartImportRequest,
  ImportJob,
  ImportEvent,
  KeyMoment,
  ModelInfo,
  SessionSummary,
  TranscriptMessage,
  Character,
  CreatePlayGameRequest,
  PlayGame,
  PlayEvent,
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

/**
 * Import a single game from PGN/FEN. The server parses it and returns the game
 * plus its content hash (no server persistence); the caller writes it into the
 * client library.
 */
export function importGame(
  body: ImportGameRequest,
): Promise<ImportGameResponse> {
  return request<ImportGameResponse>("/games", {
    method: "POST",
    body: JSON.stringify(body),
  });
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

/**
 * Streaming variant of {@link analyzeGame}: POSTs the game and reads an SSE
 * stream of {@link AnalyzeGameStreamEvent}s. `onProgress` fires after each ply
 * (with the just-completed eval, its ply, and the total ply count) so the UI
 * can show live Stockfish progress; the promise resolves with the full
 * {@link MoveEval}[] on `done` and rejects on `error`. Uses `fetch` + a
 * streaming body (not `EventSource`, which is GET-only and can't send a body).
 */
export async function analyzeGameStream(
  body: AnalyzeGameRequest,
  onProgress: (event: { ply: number; total: number; eval: MoveEval }) => void,
): Promise<MoveEval[]> {
  const res = await fetch(`${BASE}/analysis/game/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const message = await extractError(res);
    throw new ApiError(res.status, message);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let evals: MoveEval[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE frames are separated by a blank line. A single `data:` line per frame.
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const line = frame.startsWith("data:")
        ? frame.slice(5).trim()
        : frame.trim();
      if (!line) continue;
      let event: AnalyzeGameStreamEvent;
      try {
        event = JSON.parse(line) as AnalyzeGameStreamEvent;
      } catch {
        continue;
      }
      if (event.type === "progress") {
        evals.push(event.eval);
        onProgress({ ply: event.ply, total: event.total, eval: event.eval });
      } else if (event.type === "done") {
        evals = event.evals;
      } else if (event.type === "error") {
        throw new ApiError(500, event.message);
      }
    }
  }
  return evals;
}

/**
 * Surface a game's decisive moments (inaccuracies/mistakes/blunders, capped, with
 * the turning point flagged) for the review panel. By-value: send the game with
 * its analysis attached. Returns `[]` when the game has no analysis yet, so the
 * caller can show an "analyze to see key moments" state.
 */
export function keyMoments(body: KeyMomentsRequest): Promise<KeyMoment[]> {
  return request<KeyMoment[]>("/analysis/key-moments", {
    method: "POST",
    body: JSON.stringify(body),
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

/** List the active backend's available models for the picker. */
export function listModels(): Promise<ModelInfo[]> {
  return request<ModelInfo[]>("/agent/models");
}

/** List stored agent sessions for the history popover. */
export function listSessions(): Promise<SessionSummary[]> {
  return request<SessionSummary[]>("/agent/sessions");
}

/** Fetch a stored session's transcript (user/assistant text) for continue. */
export function getSessionMessages(id: string): Promise<TranscriptMessage[]> {
  return request<TranscriptMessage[]>(
    `/agent/sessions/${encodeURIComponent(id)}`,
  );
}

export async function sendAgentMessage(
  sessionId: string,
  body: AgentMessageRequest,
): Promise<void> {
  await request<unknown>(`/agent/${encodeURIComponent(sessionId)}/messages`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Opens a persistent SSE stream of {@link AgentEvent}s for a chat session.
 * The caller owns the returned {@link EventSource} and must `.close()` it.
 * `model`/`resume` are read by the server when the session is created/resumed.
 */
export function openAgentStream(
  sessionId: string,
  onEvent: (e: AgentEvent) => void,
  opts?: { model?: string; resume?: string },
): EventSource {
  const params = new URLSearchParams();
  if (opts?.model) params.set("model", opts.model);
  if (opts?.resume) params.set("resume", opts.resume);
  const qs = params.toString();
  const source = new EventSource(
    `${BASE}/agent/${encodeURIComponent(sessionId)}/stream${qs ? `?${qs}` : ""}`,
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

/** The play-mode character roster for the picker. */
export function listCharacters(): Promise<Character[]> {
  return request<Character[]>("/play/characters");
}

/** Start a new play-mode game against a character. */
export function createPlayGame(body: CreatePlayGameRequest): Promise<PlayGame> {
  return request<PlayGame>("/play", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Fetch the current state of a play-mode game. */
export function getPlayGame(id: string): Promise<PlayGame> {
  return request<PlayGame>(`/play/${encodeURIComponent(id)}`);
}

/** Submit the human's move (SAN or UCI); the AI reply arrives over the stream. */
export function sendPlayMove(id: string, move: string): Promise<PlayGame> {
  return request<PlayGame>(`/play/${encodeURIComponent(id)}/move`, {
    method: "POST",
    body: JSON.stringify({ move }),
  });
}

/** Resign the game on the human's behalf. */
export function resignPlayGame(id: string): Promise<PlayGame> {
  return request<PlayGame>(`/play/${encodeURIComponent(id)}/resign`, {
    method: "POST",
  });
}

/** Offer a draw; the character's `draw_response` arrives over the stream. */
export function offerPlayDraw(id: string): Promise<void> {
  return request<void>(`/play/${encodeURIComponent(id)}/draw-offer`, {
    method: "POST",
  });
}

/** Send a chat message to the character; the reply streams as `chat_delta`s. */
export function sendPlayChat(id: string, text: string): Promise<void> {
  return request<void>(`/play/${encodeURIComponent(id)}/chat`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

/**
 * Opens a persistent SSE stream of {@link PlayEvent}s for a play-mode game.
 * The caller owns the returned {@link EventSource}: it wires `onmessage`
 * (parsing each frame as a {@link PlayEvent}) and must `.close()` it.
 */
export function openPlayStream(id: string): EventSource {
  return new EventSource(`${BASE}/play/${encodeURIComponent(id)}/events`);
}

export { ApiError };
