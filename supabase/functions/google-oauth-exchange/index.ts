/**
 * google-oauth-exchange — Supabase Edge Function
 * ----------------------------------------------------------------------------
 * Step 4 of the Google Calendar connect flow:
 *
 *   1. (Client) User taps "Connect Google Calendar"
 *   2. (Client) `expo-auth-session` opens Google's OAuth screen
 *   3. (Client) User grants access; Google redirects back with an auth `code`
 *   4. (Client) POSTs `{ code, code_verifier, redirect_uri }` to THIS function
 *   5. (This function)  exchanges code for { access_token, refresh_token,
 *                       expires_in } and stores them, server-side, in
 *                       google_oauth_tokens.
 *   6. (Client) Triggers `google-calendar-sync` to fetch initial events.
 *
 * Secrets required:
 *   - GOOGLE_OAUTH_CLIENT_ID      (Web OAuth client ID from Google Cloud)
 *   - GOOGLE_OAUTH_CLIENT_SECRET  (Web OAuth client secret)
 *
 * The function uses the user's JWT to identify them, then writes to the
 * tokens table using the service-role key (bypassing RLS — no policies
 * allow client writes).
 * ----------------------------------------------------------------------------
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const GOOGLE_OAUTH_CLIENT_ID = Deno.env.get('GOOGLE_OAUTH_CLIENT_ID');
const GOOGLE_OAUTH_CLIENT_SECRET = Deno.env.get('GOOGLE_OAUTH_CLIENT_SECRET');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type ExchangeBody = {
  code: string;
  code_verifier?: string;
  redirect_uri: string;
};

type GoogleTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') return jsonRes({ error: 'POST required' }, 405);

  if (!GOOGLE_OAUTH_CLIENT_ID || !GOOGLE_OAUTH_CLIENT_SECRET) {
    return jsonRes(
      {
        error:
          'Google OAuth not configured. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in Supabase secrets.',
      },
      500
    );
  }

  // Identify the caller via their JWT.
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return jsonRes({ error: 'Missing Authorization' }, 401);
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const {
    data: { user },
    error: userErr,
  } = await userClient.auth.getUser();
  if (userErr || !user) return jsonRes({ error: 'Unauthorized' }, 401);

  // Parse body.
  let body: ExchangeBody;
  try {
    body = (await req.json()) as ExchangeBody;
  } catch {
    return jsonRes({ error: 'Invalid JSON body' }, 400);
  }
  if (!body.code || !body.redirect_uri) {
    return jsonRes({ error: 'code and redirect_uri are required' }, 400);
  }

  // Exchange the auth code with Google.
  const params = new URLSearchParams({
    code: body.code,
    client_id: GOOGLE_OAUTH_CLIENT_ID,
    client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
    redirect_uri: body.redirect_uri,
    grant_type: 'authorization_code',
  });
  if (body.code_verifier) {
    params.set('code_verifier', body.code_verifier);
  }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!tokenRes.ok) {
    const errBody = await tokenRes.text();
    console.error('Google token exchange failed:', tokenRes.status, errBody);
    return jsonRes(
      {
        error: 'Token exchange with Google failed',
        status: tokenRes.status,
        detail: errBody,
      },
      502
    );
  }

  const tokens = (await tokenRes.json()) as GoogleTokenResponse;
  if (!tokens.refresh_token) {
    // Only happens when the user has previously authorized this app and we
    // didn't pass `prompt=consent`. The client should request offline access
    // with prompt=consent on first connect. Surface a clear error.
    return jsonRes(
      {
        error:
          'No refresh_token returned. This usually means Google previously authorized this app and didn\'t re-issue one. Disconnect from Google account permissions and try again, or pass prompt=consent on the client.',
      },
      400
    );
  }

  // Persist tokens with service role (bypasses RLS).
  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const expiresAt = new Date(Date.now() + (tokens.expires_in - 30) * 1000);
  // The -30s buffer keeps a margin for clock skew + in-flight requests.

  const { error: dbErr } = await adminClient.from('google_oauth_tokens').upsert(
    {
      user_id: user.id,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_expires_at: expiresAt.toISOString(),
      scope: tokens.scope ?? null,
      last_sync_error: null,
    },
    { onConflict: 'user_id' }
  );

  if (dbErr) {
    console.error('Failed to store tokens:', dbErr);
    return jsonRes({ error: 'Failed to store tokens', detail: dbErr.message }, 500);
  }

  return jsonRes(
    {
      success: true,
      scope: tokens.scope ?? null,
      expires_at: expiresAt.toISOString(),
    },
    200
  );
});

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
