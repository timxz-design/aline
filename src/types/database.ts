// Auto-generated from Supabase schema (regenerated 2026-05-09).
// To regenerate: use the Supabase MCP `generate_typescript_types` tool,
// or run: npx supabase gen types typescript --project-id etsyyjwulqrbnogwjifh

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: '14.5';
  };
  public: {
    Tables: {
      behavioral_pings: {
        Row: {
          battery_level: number | null;
          captured_at: string;
          created_at: string;
          geohash_8: string;
          id: string;
          motion_state: string | null;
          user_id: string;
        };
        Insert: {
          battery_level?: number | null;
          captured_at: string;
          created_at?: string;
          geohash_8: string;
          id?: string;
          motion_state?: string | null;
          user_id: string;
        };
        Update: Partial<Database['public']['Tables']['behavioral_pings']['Insert']>;
        Relationships: [];
      };
      behavioral_summary: {
        Row: {
          archetype_text: string | null;
          avg_daily_steps: number | null;
          bedtime_minute: number | null;
          chronotype: string | null;
          data_quality: string;
          updated_at: string;
          user_id: string;
          waketime_minute: number | null;
          weekly_workout_count: number | null;
        };
        Insert: {
          archetype_text?: string | null;
          avg_daily_steps?: number | null;
          bedtime_minute?: number | null;
          chronotype?: string | null;
          data_quality?: string;
          updated_at?: string;
          user_id: string;
          waketime_minute?: number | null;
          weekly_workout_count?: number | null;
        };
        Update: Partial<Database['public']['Tables']['behavioral_summary']['Insert']>;
        Relationships: [];
      };
      calendar_events: {
        Row: {
          created_at: string | null;
          description: string | null;
          end_at: string;
          event_type: string | null;
          external_id: string | null;
          hangout_id: string | null;
          id: string;
          is_movable: boolean;
          location: string | null;
          original_start_at: string | null;
          source: string | null;
          start_at: string;
          title: string | null;
          updated_at: string | null;
          user_id: string;
        };
        Insert: {
          created_at?: string | null;
          description?: string | null;
          end_at: string;
          event_type?: string | null;
          external_id?: string | null;
          hangout_id?: string | null;
          id?: string;
          is_movable?: boolean;
          location?: string | null;
          original_start_at?: string | null;
          source?: string | null;
          start_at: string;
          title?: string | null;
          updated_at?: string | null;
          user_id: string;
        };
        Update: Partial<Database['public']['Tables']['calendar_events']['Insert']>;
        Relationships: [];
      };
      change_sets: {
        Row: {
          chat_message_id: string | null;
          created_at: string;
          expires_at: string;
          id: string;
          operations: Json;
          reasoning: string | null;
          status: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          chat_message_id?: string | null;
          created_at?: string;
          expires_at?: string;
          id?: string;
          operations: Json;
          reasoning?: string | null;
          status?: string;
          updated_at?: string;
          user_id: string;
        };
        Update: Partial<Database['public']['Tables']['change_sets']['Insert']>;
        Relationships: [];
      };
      chat_messages: {
        Row: {
          content: string;
          context_snapshot: Json | null;
          created_at: string | null;
          extracted_data: Json | null;
          id: string;
          input_tokens: number | null;
          model: string | null;
          output_tokens: number | null;
          role: string;
          user_id: string;
        };
        Insert: {
          content: string;
          context_snapshot?: Json | null;
          created_at?: string | null;
          extracted_data?: Json | null;
          id?: string;
          input_tokens?: number | null;
          model?: string | null;
          output_tokens?: number | null;
          role: string;
          user_id: string;
        };
        Update: Partial<Database['public']['Tables']['chat_messages']['Insert']>;
        Relationships: [];
      };
      friendships: {
        Row: {
          created_at: string | null;
          requested_by: string | null;
          status: string;
          updated_at: string | null;
          user_a: string;
          user_b: string;
        };
        Insert: {
          created_at?: string | null;
          requested_by?: string | null;
          status: string;
          updated_at?: string | null;
          user_a: string;
          user_b: string;
        };
        Update: Partial<Database['public']['Tables']['friendships']['Insert']>;
        Relationships: [];
      };
      goals: {
        Row: {
          category: string | null;
          created_at: string | null;
          id: string;
          is_aspirational: boolean | null;
          last_completed_at: string | null;
          notes: string | null;
          status: string | null;
          target_date: string | null;
          target_per_week: number | null;
          title: string;
          updated_at: string | null;
          user_id: string;
        };
        Insert: {
          category?: string | null;
          created_at?: string | null;
          id?: string;
          is_aspirational?: boolean | null;
          last_completed_at?: string | null;
          notes?: string | null;
          status?: string | null;
          target_date?: string | null;
          target_per_week?: number | null;
          title: string;
          updated_at?: string | null;
          user_id: string;
        };
        Update: Partial<Database['public']['Tables']['goals']['Insert']>;
        Relationships: [];
      };
      group_members: {
        Row: {
          group_id: string;
          joined_at: string | null;
          role: string | null;
          trust_tier: string | null;
          user_id: string;
        };
        Insert: {
          group_id: string;
          joined_at?: string | null;
          role?: string | null;
          trust_tier?: string | null;
          user_id: string;
        };
        Update: Partial<Database['public']['Tables']['group_members']['Insert']>;
        Relationships: [];
      };
      groups: {
        Row: {
          created_at: string | null;
          created_by: string;
          description: string | null;
          group_type: string | null;
          id: string;
          name: string;
          updated_at: string | null;
        };
        Insert: {
          created_at?: string | null;
          created_by: string;
          description?: string | null;
          group_type?: string | null;
          id?: string;
          name: string;
          updated_at?: string | null;
        };
        Update: Partial<Database['public']['Tables']['groups']['Insert']>;
        Relationships: [];
      };
      hangout_responses: {
        Row: {
          hangout_id: string;
          note: string | null;
          responded_at: string | null;
          status: string | null;
          user_id: string;
        };
        Insert: {
          hangout_id: string;
          note?: string | null;
          responded_at?: string | null;
          status?: string | null;
          user_id: string;
        };
        Update: Partial<Database['public']['Tables']['hangout_responses']['Insert']>;
        Relationships: [];
      };
      hangouts: {
        Row: {
          confidence: number | null;
          created_at: string | null;
          description: string | null;
          group_id: string;
          id: string;
          min_attendees: number;
          proposed_by: string;
          proposed_end: string | null;
          proposed_start: string | null;
          reasoning: string | null;
          status: string | null;
          title: string;
          updated_at: string | null;
          venue_address: string | null;
          venue_lat: number | null;
          venue_lng: number | null;
          venue_name: string | null;
        };
        Insert: {
          confidence?: number | null;
          created_at?: string | null;
          description?: string | null;
          group_id: string;
          id?: string;
          min_attendees?: number;
          proposed_by: string;
          proposed_end?: string | null;
          proposed_start?: string | null;
          reasoning?: string | null;
          status?: string | null;
          title: string;
          updated_at?: string | null;
          venue_address?: string | null;
          venue_lat?: number | null;
          venue_lng?: number | null;
          venue_name?: string | null;
        };
        Update: Partial<Database['public']['Tables']['hangouts']['Insert']>;
        Relationships: [];
      };
      interests: {
        Row: {
          active: boolean | null;
          confidence: number | null;
          created_at: string | null;
          id: string;
          key: string;
          source: string | null;
          updated_at: string | null;
          user_id: string;
          value: Json;
        };
        Insert: {
          active?: boolean | null;
          confidence?: number | null;
          created_at?: string | null;
          id?: string;
          key: string;
          source?: string | null;
          updated_at?: string | null;
          user_id: string;
          value: Json;
        };
        Update: Partial<Database['public']['Tables']['interests']['Insert']>;
        Relationships: [];
      };
      places: {
        Row: {
          category: string | null;
          confidence: number | null;
          created_at: string;
          first_seen: string;
          geohash_5: string;
          geohash_7: string;
          google_place_id: string | null;
          id: string;
          inference_status: string;
          is_hidden: boolean;
          is_sensitive: boolean;
          last_asked_at: string | null;
          last_seen: string;
          name: string | null;
          ping_count: number;
          primary_type: string | null;
          updated_at: string;
          user_id: string;
          user_label: string | null;
          visit_count: number;
        };
        Insert: {
          category?: string | null;
          confidence?: number | null;
          created_at?: string;
          first_seen?: string;
          geohash_5: string;
          geohash_7: string;
          google_place_id?: string | null;
          id?: string;
          inference_status?: string;
          is_hidden?: boolean;
          is_sensitive?: boolean;
          last_asked_at?: string | null;
          last_seen?: string;
          name?: string | null;
          ping_count?: number;
          primary_type?: string | null;
          updated_at?: string;
          user_id: string;
          user_label?: string | null;
          visit_count?: number;
        };
        Update: Partial<Database['public']['Tables']['places']['Insert']>;
        Relationships: [];
      };
      profiles: {
        Row: {
          archetype_summary: string | null;
          created_at: string | null;
          display_name: string | null;
          expo_push_token: string | null;
          first_name: string | null;
          handle: string | null;
          id: string;
          onboarding_complete: boolean | null;
          push_notifications_enabled: boolean;
          push_token_updated_at: string | null;
          social_openness: string | null;
          timezone: string | null;
          updated_at: string | null;
        };
        Insert: {
          archetype_summary?: string | null;
          created_at?: string | null;
          display_name?: string | null;
          expo_push_token?: string | null;
          first_name?: string | null;
          handle?: string | null;
          id: string;
          onboarding_complete?: boolean | null;
          push_notifications_enabled?: boolean;
          push_token_updated_at?: string | null;
          social_openness?: string | null;
          timezone?: string | null;
          updated_at?: string | null;
        };
        Update: Partial<Database['public']['Tables']['profiles']['Insert']>;
        Relationships: [];
      };
      routines: {
        Row: {
          active: boolean;
          category: string | null;
          consistency: number | null;
          created_at: string;
          day_of_week: number | null;
          end_minute: number | null;
          id: string;
          inference_status: string;
          last_asked_at: string | null;
          last_observed: string | null;
          place_id: string | null;
          start_minute: number | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          active?: boolean;
          category?: string | null;
          consistency?: number | null;
          created_at?: string;
          day_of_week?: number | null;
          end_minute?: number | null;
          id?: string;
          inference_status?: string;
          last_asked_at?: string | null;
          last_observed?: string | null;
          place_id?: string | null;
          start_minute?: number | null;
          updated_at?: string;
          user_id: string;
        };
        Update: Partial<Database['public']['Tables']['routines']['Insert']>;
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      add_friends_to_group: {
        Args: { _group_id: string; _user_ids: string[] };
        Returns: number;
      };
      apply_change_set: { Args: { _id: string }; Returns: Json };
      create_group: {
        Args: { _name: string; _description?: string | null; _group_type?: string | null };
        Returns: string;
      };
      disconnect_google_calendar: { Args: Record<string, never>; Returns: undefined };
      find_user_by_handle: {
        Args: { _handle: string };
        Returns: Array<{
          id: string;
          handle: string | null;
          first_name: string | null;
          display_name: string | null;
        }>;
      };
      google_calendar_status: {
        Args: Record<string, never>;
        Returns: Array<{
          connected: boolean;
          last_synced_at: string | null;
          last_sync_error: string | null;
        }>;
      };
      is_group_admin: { Args: { _group_id: string }; Returns: boolean };
      is_group_member: { Args: { _group_id: string }; Returns: boolean };
      mark_curiosity_asked: {
        Args: { _kind: string; _id: string };
        Returns: undefined;
      };
      next_curiosity_item: {
        Args: Record<string, never>;
        Returns: Array<{ kind: string; id: string; payload: Json }>;
      };
      propose_hangout: {
        Args: {
          _group_id: string;
          _title: string;
          _proposed_start: string;
          _reasoning: string;
          _description?: string | null;
          _proposed_end?: string | null;
          _venue_name?: string | null;
          _venue_address?: string | null;
          _confidence?: number | null;
          _min_attendees?: number | null;
        };
        Returns: string;
      };
      reject_change_set: { Args: { _id: string }; Returns: undefined };
      request_friendship_by_handle: {
        Args: { _handle: string };
        Returns: 'request_sent' | 'already_friends' | 'request_pending' | 'auto_accepted' | string;
      };
      respond_to_friendship: {
        Args: { _other_user: string; _action: 'accept' | 'decline' };
        Returns: undefined;
      };
      respond_to_hangout: {
        Args: { _hangout_id: string; _status: 'confirmed' | 'declined' | 'maybe' | 'pending' };
        Returns: undefined;
      };
      send_push_to_users: {
        Args: { _user_ids: string[]; _title: string; _body: string; _data?: Json };
        Returns: undefined;
      };
      set_handle: { Args: { _handle: string }; Returns: undefined };
      set_push_token: { Args: { _token: string | null }; Returns: undefined };
      shares_group_with: { Args: { _other_user: string }; Returns: boolean };
      unfriend: { Args: { _other_user: string }; Returns: undefined };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};

// Convenience aliases
export type Profile = Database['public']['Tables']['profiles']['Row'];
export type Goal = Database['public']['Tables']['goals']['Row'];
export type Interest = Database['public']['Tables']['interests']['Row'];
export type Group = Database['public']['Tables']['groups']['Row'];
export type GroupMember = Database['public']['Tables']['group_members']['Row'];
export type Hangout = Database['public']['Tables']['hangouts']['Row'];
export type HangoutResponse = Database['public']['Tables']['hangout_responses']['Row'];
export type CalendarEvent = Database['public']['Tables']['calendar_events']['Row'];
export type ChatMessage = Database['public']['Tables']['chat_messages']['Row'];
export type Friendship = Database['public']['Tables']['friendships']['Row'];
export type ChangeSet = Database['public']['Tables']['change_sets']['Row'];

// ---------- change_sets operation shapes -----------------------------------
// The `operations` field is jsonb on the DB; these are the typed shapes the
// agent emits and the client interprets.

export type ChangeSetMoveOp = {
  op: 'move';
  event_id: string;
  new_start: string;
  new_end: string;
  reasoning?: string;
};

export type ChangeSetCreateOp = {
  op: 'create';
  title: string;
  start_at: string;
  end_at: string;
  event_type: 'flexible' | 'goal' | 'fixed' | 'coordinated';
  description?: string;
  location?: string;
  hangout_id?: string;
  goal_id?: string;
  reasoning?: string;
};

export type ChangeSetOperation = ChangeSetMoveOp | ChangeSetCreateOp;
