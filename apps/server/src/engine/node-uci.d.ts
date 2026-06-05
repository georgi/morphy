/**
 * Minimal ambient types for `node-uci` ^1.3 — the package ships no type
 * declarations and there is no @types/node-uci. Modelled against the verified
 * 1.3.4 source (src/Engine/index.js, src/parseUtil/*, src/const.js).
 *
 * Only the surface used by EngineService is declared.
 */
declare module 'node-uci' {
  import { ChildProcess } from 'child_process';

  /** Score object as parsed by parseInfo (`score: { unit, value }`). */
  export interface InfoScore {
    unit: 'cp' | 'mate' | 'lowerbound' | 'upperbound';
    value: number;
  }

  /**
   * A parsed `info` line. Numeric fields are `parseFloat`'d; `pv` stays a
   * space-separated STRING (must be split by the caller); `score` is an object.
   */
  export interface Info {
    depth?: number;
    seldepth?: number;
    time?: number;
    nodes?: number;
    nps?: number;
    hashfull?: number;
    tbhits?: number;
    multipv?: number;
    currmovenumber?: number;
    cpuload?: number;
    score?: InfoScore;
    /** Space-separated moves in engine notation — NOT an array. */
    pv?: string;
    currmove?: string;
    string?: string;
    refutation?: string;
    currline?: string;
    [key: string]: unknown;
  }

  /** Resolved shape of `go()` (from goReducer). */
  export interface BestMove {
    /** Best move in engine (UCI) notation, or null if never reported. */
    bestmove: string | null;
    /** Present only when the engine sent `bestmove X ponder Y`. */
    ponder?: string;
    /** Every parsed info line, chronological across all depths / multipv slots. */
    info: Info[];
  }

  export interface GoOptions {
    searchmoves?: string[];
    ponder?: boolean;
    wtime?: number;
    btime?: number;
    winc?: number;
    binc?: number;
    movestogo?: number;
    depth?: number;
    nodes?: number;
    mate?: number;
    movetime?: number;
  }

  export interface EngineId {
    name?: string;
    author?: string;
  }

  export class Engine {
    constructor(filePath: string);

    /** Underlying spawned process; deleted after `quit()`. */
    proc?: ChildProcess;
    id: EngineId;
    options: Map<string, unknown>;

    /** Spawns the process, sends `uci`, waits for `uciok`. */
    init(): Promise<Engine>;
    /** Sends `quit`, waits for the process `close` event, detaches listeners. */
    quit(): Promise<Engine>;
    /** Sends `isready`, waits for `readyok`. */
    isready(): Promise<Engine>;
    /** Sends `ucinewgame`, then `isready`. */
    ucinewgame(): Promise<Engine>;
    /** Sends `setoption name <name> [value <value>]`, then `isready`. */
    setoption(name: string, value?: string | number): Promise<Engine>;
    /**
     * Sends `position`. Pass a RAW fen (no leading "fen") or the string
     * `'startpos'`; optional `moves` are appended in engine notation.
     */
    position(fen: string, moves?: string[]): Promise<Engine>;
    /** Sends `go <opts>`, resolves when a `bestmove` line arrives. */
    go(options: GoOptions): Promise<BestMove>;
    stop(): Promise<BestMove>;
  }

  export class EngineChain {
    constructor(engine: Engine);
  }
}
