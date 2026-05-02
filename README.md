# ALINE — MVP app

Your personal AI agent. Coordinates hangouts with your friend groups by talking
to other people's agents. Built on React Native + Expo + Supabase.

## What's in this MVP

The first vertical slice covers:

- **Auth** (email + password, Supabase)
- **My Week** — weekly schedule view with color-coded events
  (Fixed / Flexible / Goal / Coordinated)
- **Groups** — create friend groups, see upcoming coordinated hangouts
- **Agent** — chat with ALINE, powered by Claude via the
  `agent-respond` Supabase Edge Function. Loads user context (profile,
  goals, preferences, groups, recent chat), sends to Claude, persists
  the reply, and extracts new structured preferences from the message.

What we explicitly do NOT have yet (and don't need yet):

- Custom ML models — rule-based logic until we have real user data
- Stranger discovery / matching — Phase 2 after group coordination is solid
- Calendar sync — UI is ready for it; OAuth flow goes in next
- Location tracking / behavioral profile building — Phase 2

## Tech stack

| Layer | Choice |
|---|---|
| Mobile | Expo SDK 54, React Native 0.81, TypeScript |
| Routing | expo-router (file-based, typed routes) |
| Backend | Supabase (Postgres + Auth + Realtime + Edge Functions) |
| Storage | AsyncStorage for auth tokens |
| LLM (next) | Claude API via a Supabase Edge Function |

## Getting started

```bash
cd aline-app
npm install
# the .env file already contains the Supabase URL + publishable key
npm start
```

Then press `a` for Android, `i` for iOS (Mac only), or `w` for web.

### One-time setup: Anthropic API key

The agent chat is powered by Claude via the `agent-respond` edge function.
For chat to work, the function needs your Anthropic API key:

1. Get a key at <https://console.anthropic.com/> (you only need API
   credits — no separate Claude Pro subscription needed).
2. Open the Supabase dashboard → your project → **Edge Functions** →
   **Secrets** (or **Project Settings → Edge Functions → Secrets**
   depending on your dashboard version).
3. Add a new secret:
   - Name: `ANTHROPIC_API_KEY`
   - Value: `sk-ant-api03-...` (your key)
4. (Optional) Add `ANTHROPIC_MODEL` if you want to override the default
   `claude-sonnet-4-5`. For example: `claude-sonnet-4-6`.

The function is already deployed. Saving the secret takes effect on the
next invocation — no redeploy needed.

### One-time setup: Google Calendar OAuth

The Connect Google Calendar button on the Profile screen needs an OAuth client
ID + secret from Google Cloud. ~10 minutes, one-time.

**1. Create / select a Google Cloud project**

- Go to <https://console.cloud.google.com>
- Create a new project (e.g. "ALINE") or select an existing one

**2. Enable the Calendar API**

- Sidebar → **APIs & Services → Library**
- Search "Google Calendar API" → click → **Enable**

**3. Configure the OAuth consent screen**

- Sidebar → **APIs & Services → OAuth consent screen**
- User type: **External**, then **Create**
- App name: `ALINE`, support email: yours
- Save and continue
- **Scopes**: click "Add or remove scopes", add:
  - `.../auth/calendar.readonly`
  - `.../auth/calendar.events.readonly`
  - `openid`, `email`, `profile`
- Save
- **Test users**: add your own Google email (and any friend testers).
  While the app is in "Testing" mode only listed test users can connect —
  that's fine for the friend test, no review needed.

**4. Create OAuth credentials**

- Sidebar → **APIs & Services → Credentials → Create credentials → OAuth client ID**
- Application type: **Web application**
- Name: `ALINE Web`
- **Authorized redirect URIs** — add ALL of these:
  - `https://auth.expo.io/@<your-expo-username>/aline-app`
  - `https://localhost:8081`
  - `http://localhost:8081`
  - `https://localhost:19006`
  - `aline://oauth/google`

  (You can find your Expo username at <https://expo.dev/settings>. If you
  don't have an Expo account, create one for free — `npx expo login`.)
- Click **Create**. Copy the **Client ID** and **Client Secret**.

**5. Wire the secrets up**

- **Supabase dashboard** → your project → **Edge Functions → Secrets**
  - Add `GOOGLE_OAUTH_CLIENT_ID` = (the Client ID)
  - Add `GOOGLE_OAUTH_CLIENT_SECRET` = (the Client Secret)
- **Local `.env`** in `aline-app/`:
  ```
  EXPO_PUBLIC_GOOGLE_CLIENT_ID=<the same Client ID>
  ```

**6. Restart the dev server** (`npm start --` → `r` to reload).

Tap **Connect Google Calendar** in the Profile tab. Google's permission screen
opens, you grant access, the app hits `google-oauth-exchange` to swap the code
for tokens, then `google-calendar-sync` pulls your events. They'll appear on
the My Week tab.

### Cost guardrails

Each chat turn sends ~2-4K input tokens (system prompt + recent history
+ profile context) and gets ~200-800 output tokens back. With Sonnet
that's roughly $0.01-0.03 per turn. If a user sends 5 messages a day,
that's ~$2-5 per active user per month. Watch your Anthropic usage
dashboard for the first week of testing.

## Project structure

```
aline-app/
├── app/                       # expo-router file-based routes
│   ├── _layout.tsx            # root: providers + auth gate
│   ├── index.tsx              # redirects based on auth state
│   ├── (auth)/                # signed-out routes
│   │   ├── _layout.tsx
│   │   ├── sign-in.tsx
│   │   └── sign-up.tsx
│   └── (app)/                 # signed-in tabs
│       ├── _layout.tsx        # bottom tab bar
│       ├── week.tsx           # schedule view
│       ├── groups.tsx         # friend groups + hangouts
│       └── agent.tsx          # chat with ALINE
├── src/
│   ├── components/            # shared UI primitives
│   ├── lib/
│   │   ├── supabase.ts        # Supabase client singleton
│   │   ├── auth-context.tsx   # session state + sign-in/up/out
│   │   └── date-utils.ts      # week math helpers
│   ├── theme/                 # colors, spacing, typography
│   └── types/database.ts      # auto-generated Supabase types
├── app.json                   # Expo config (permissions, plugins)
└── .env                       # Supabase URL + anon key (gitignored)
```

## Database schema

Defined in Supabase migration `init_aline_schema`. Tables:

- `profiles` — extends `auth.users` with ALINE-specific fields
- `goals` — what users are trying to do
- `interests` — flexible structured prefs extracted from chat
- `groups` + `group_members` — friend groups (3-tier trust: friends / inner_circle)
- `hangouts` + `hangout_responses` — coordinated meetups
- `calendar_events` — synced from Google/Apple, plus ALINE-created
- `chat_messages` — full conversation history with the agent

Every table has Row Level Security: users only see/modify their own data,
plus group data they're a member of.

To regenerate TypeScript types after schema changes: use the Supabase MCP
`generate_typescript_types` tool, or:

```bash
npx supabase gen types typescript --project-id etsyyjwulqrbnogwjifh > src/types/database.ts
```

## Edge Functions

Edge function source lives in `supabase/functions/<function-name>/index.ts`.

- **agent-respond** — `POST { user_message_id }`. Loads user context,
  calls Claude, persists agent reply + extracted preferences. Requires
  `ANTHROPIC_API_KEY` secret. JWT verification is enforced.

To redeploy after editing:

```bash
# either use the Supabase CLI:
supabase functions deploy agent-respond --project-ref etsyyjwulqrbnogwjifh

# or call the MCP `deploy_edge_function` tool from this Claude Code session
```

## Next milestones

1. **Hangout proposal flow** — "plan dinner with the crew" → agent computes
   calendar overlap → inserts a `hangouts` row → group members confirm
2. **Calendar sync** — Google OAuth → fetch events → write to `calendar_events`
3. **Onboarding** — 60-second flow: calendar sync + 3 taps for goals + social openness
4. **Location tracking + routine detection** — Phase 2

## Design principles (locked, do not break)

1. Connections find you — proactive, not search-first
2. Algorithm earns trust through consistency
3. Transparent reasoning — always show WHY
4. Suggest, never control — copilot, not autopilot. Never manipulate.
5. Goals drive matching, behavioral data enables it
6. Complementary personalities, not just similar ones
7. Fluid groups, not locked cliques
8. Confidence injection — "you belong because the data says so"
9. Behavioral verification — actions over words
10. Proportional safety — protect immediately, investigate fairly, rehabilitate
