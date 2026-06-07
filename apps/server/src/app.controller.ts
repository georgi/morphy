import { Controller, Get } from '@nestjs/common';

/**
 * Root + health endpoints.
 *
 * The JSON API lives under the global `api` prefix (see main.ts). The root
 * `GET /` is excluded from that prefix so that opening the server in a browser
 * returns a helpful pointer instead of a bare 404 — the Morphy UI is
 * served separately by the Vite dev server, not by this process.
 */
@Controller()
export class AppController {
  @Get()
  root() {
    return {
      name: 'Morphy API',
      status: 'ok',
      api: '/api',
      web: 'http://localhost:5173',
      hint:
        'This port serves the JSON API under /api. The Morphy UI runs ' +
        'on the Vite dev server — open http://localhost:5173 (both are started ' +
        'by `pnpm dev`).',
      endpoints: [
        'POST /api/games',
        'GET  /api/games/:id',
        'POST /api/analysis/position',
        'POST /api/analysis/game',
        'GET  /api/agent/:sessionId/stream',
        'POST /api/agent/:sessionId/messages',
        'GET  /api/health',
      ],
    };
  }

  @Get('health')
  health() {
    return { status: 'ok' };
  }
}
