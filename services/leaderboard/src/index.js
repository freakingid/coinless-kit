import { GAMES } from './registry.js';
import { handleSubmit } from './scores.js';
import { handleBoard } from './board.js';

const ALLOWED_HOSTS = ['coinlessgames.com', 'itch.io', 'itch.zone', 'ungrounded.net', 'newgrounds.com'];
const DEV_HOSTS = ['localhost', '127.0.0.1'];

export function json(status, body, corsHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}

export function errorJson(status, code, message, corsHeaders = {}) {
  return json(status, { error: { code, message } }, corsHeaders);
}

function matchOrigin(originHeader, env) {
  if (!originHeader) return null;

  let host;
  try {
    host = new URL(originHeader).hostname;
  } catch {
    return null;
  }

  const hosts = env.ENVIRONMENT === 'dev' ? [...ALLOWED_HOSTS, ...DEV_HOSTS] : ALLOWED_HOSTS;
  const allowed = hosts.some((h) => host === h || host.endsWith(`.${h}`));
  return allowed ? originHeader : null;
}

function corsHeadersFor(matchedOrigin) {
  if (!matchedOrigin) return {};
  return {
    'Access-Control-Allow-Origin': matchedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin'
  };
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const origin = request.headers.get('Origin');
      const matchedOrigin = matchOrigin(origin, env);
      const corsHeaders = corsHeadersFor(matchedOrigin);

      if (request.method === 'OPTIONS') {
        if (origin && !matchedOrigin) return new Response(null, { status: 403 });
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      if (origin && !matchedOrigin) {
        return errorJson(403, 'ORIGIN_NOT_ALLOWED', 'Origin not allowed', {});
      }
      if (!origin && request.method === 'POST') {
        return errorJson(403, 'ORIGIN_NOT_ALLOWED', 'Origin header required', {});
      }

      if (url.pathname === '/v1/health') {
        if (request.method !== 'GET') return errorJson(405, 'INVALID_PAYLOAD', 'Method not allowed', corsHeaders);
        return json(200, { ok: true, games: Object.keys(GAMES) }, corsHeaders);
      }

      if (url.pathname === '/v1/scores') {
        if (request.method === 'POST') {
          return handleSubmit(request, env, corsHeaders);
        }
        if (request.method === 'GET') {
          const clientIp = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
          const rl = await env.READ_LIMITER.limit({ key: clientIp });
          if (!rl.success) {
            return errorJson(429, 'RATE_LIMITED', 'Too many requests, try again shortly', corsHeaders);
          }
          return handleBoard(request, env, corsHeaders);
        }
        return errorJson(405, 'INVALID_PAYLOAD', 'Method not allowed', corsHeaders);
      }

      return errorJson(404, 'INVALID_PAYLOAD', 'Not found', corsHeaders);
    } catch (err) {
      console.error('unhandled error', err);
      return errorJson(500, 'SERVER_ERROR', 'Something went wrong', {});
    }
  }
};
