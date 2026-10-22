/**
 * Ask the agent for a reply and receive its text as it's written.
 *
 * agent-respond answers `{ stream: true }` with server-sent events: `delta`
 * (more reply text), `reset` (drop what was shown — a tool round followed) and
 * `done` (the same result the plain call returns). The finished reply is
 * saved to chat_messages either way, so the chat loads it like any other
 * message; the streamed text only fills the bubble while it's being written.
 *
 * Uses expo/fetch: React Native's built-in fetch can't read a response body
 * as a stream.
 */

import { fetch } from 'expo/fetch';
import { supabase } from './supabase';

const FUNCTION_URL = `${process.env.EXPO_PUBLIC_SUPABASE_URL}/functions/v1/agent-respond`;

export async function streamAgentReply(
  userMessageId: string,
  onText: (textSoFar: string) => void,
): Promise<{ ok: boolean; error?: string }> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { ok: false, error: 'not signed in' };

  const res = await fetch(FUNCTION_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
      apikey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '',
    },
    body: JSON.stringify({ user_message_id: userMessageId, stream: true }),
  });
  if (!res.ok || !res.body) return { ok: false, error: `HTTP ${res.status}` };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let status = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: (.*)$/m.exec(raw)?.[1];
      const data = /^data: (.*)$/m.exec(raw)?.[1];
      if (!event || !data) continue;
      let payload: { text?: string; status?: number };
      try {
        payload = JSON.parse(data);
      } catch {
        continue;
      }
      if (event === 'delta' && payload.text) {
        text += payload.text;
        onText(text);
      } else if (event === 'reset') {
        text = '';
        onText('');
      } else if (event === 'done') {
        status = payload.status ?? 200;
      }
    }
  }
  return status >= 200 && status < 300 ? { ok: true } : { ok: false, error: `status ${status || 'none'}` };
}
