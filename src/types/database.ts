// Auto-generated from Supabase schema.
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
      calendar_events: {
        Row: {
          created_at: string | null;
          description: string | null;
          end_at: string;
          event_type: string | null;
          external_id: string | null;
          hangout_id: string | null;
          id: string;
          location: string | null;
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
          location?: string | null;
          source?: string | null;
          start_at: string;
          title?: string | null;
          updated_at?: string | null;
          user_id: string;
        };
        Update: Partial<Database['public']['Tables']['calendar_events']['Insert']>;
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
      goals: {
        Row: {
          category: string | null;
          created_at: string | null;
          id: string;
          is_aspirational: boolean | null;
          notes: string | null;
          status: string | null;
          target_date: string | null;
          title: string;
          updated_at: string | null;
          user_id: string;
        };
        Insert: {
          category?: string | null;
          created_at?: string | null;
          id?: string;
          is_aspirational?: boolean | null;
          notes?: string | null;
          status?: string | null;
          target_date?: string | null;
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
      profiles: {
        Row: {
          archetype_summary: string | null;
          created_at: string | null;
          display_name: string | null;
          first_name: string | null;
          handle: string | null;
          id: string;
          onboarding_complete: boolean | null;
          social_openness: string | null;
          timezone: string | null;
          updated_at: string | null;
          expo_push_token: string | null;
          push_notifications_enabled: boolean;
          push_token_updated_at: string | null;
        };
        Insert: {
          archetype_summary?: string | null;
          created_at?: string | null;
          display_name?: string | null;
          first_name?: string | null;
          handle?: string | null;
          id: string;
          onboarding_complete?: boolean | null;
          social_openness?: string | null;
          timezone?: string | null;
          updated_at?: string | null;
          expo_push_token?: string | null;
          push_notifications_enabled?: boolean;
          push_token_updated_at?: string | null;
        };
        Update: Partial<Database['public']['Tables']['profiles']['Insert']>;
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
    };
      behavioral_pings: {
        Row: {
          id: string;
          user_id: string;
          captured_at: string;
          geohash_8: string;
          motion_state: string | null;
          battery_level: number | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          captured_at: string;
          geohash_8: string;
          motion_state?: string | null;
          battery_level?: number | null;
          created_at?: string;
        };
        Update: Partial<Database['public']['Tables']['behavioral_pings']['Insert']>;
        Relationships: [];
      };
      places: {
        Row: {
          id: string;
          user_id: string;
          google_place_id: string | null;
          name: string | null;
          primary_type: string | null;
          category: string | null;
          geohash_5: string;
          geohash_7: string;
          visit_count: number;
          first_seen: string;
          last_seen: string;
          user_label: string | null;
          is_hidden: boolean;
          is_sensitive: boolean;
          inference_status: 'pending' | 'confirmed' | 'corrected';
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          google_place_id?: string | null;
          name?: string | null;
          primary_type?: string | null;
          category?: string | null;
          geohash_5: string;
          geohash_7: string;
          visit_count?: number;
          first_seen?: string;
          last_seen?: string;
          user_label?: string | null;
          is_hidden?: boolean;
          is_sensitive?: boolean;
          inference_status?: 'pending' | 'confirmed' | 'corrected';
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['places']['Insert']>;
        Relationships: [];
      };
      routines: {
        Row: {
          id: string;
          user_id: string;
          place_id: string | null;
          category: string | null;
          day_of_week: number | null;
          start_minute: number | null;
          end_minute: number | null;
          consistency: number | null;
          last_observed: string | null;
          active: boolean;
          inference_status: 'pending' | 'confirmed' | 'corrected';
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          place_id?: string | null;
          category?: string | null;
          day_of_week?: number | null;
          start_minute?: number | null;
          end_minute?: number | null;
          consistency?: number | null;
          last_observed?: string | null;
          active?: boolean;
          inference_status?: 'pending' | 'confirmed' | 'corrected';
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['routines']['Insert']>;
        Relationships: [];
      };
      behavioral_summary: {
        Row: {
          user_id: string;
          archetype_text: string | null;
          chronotype: 'early_bird' | 'night_owl' | 'intermediate' | null;
          bedtime_minute: number | null;
          waketime_minute: number | null;
          weekly_workout_count: number | null;
          avg_daily_steps: number | null;
          data_quality: 'none' | 'low' | 'medium' | 'high';
          updated_at: string;
        };
        Insert: {
          user_id: string;
          archetype_text?: string | null;
          chronotype?: 'early_bird' | 'night_owl' | 'intermediate' | null;
          bedtime_minute?: number | null;
          waketime_minute?: number | null;
          weekly_workout_count?: number | null;
          avg_daily_steps?: number | null;
          data_quality?: 'none' | 'low' | 'medium' | 'high';
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['behavioral_summary']['Insert']>;
        Relationships: [];
      };
    Views: { [_ in never]: never };
    Functions: {
      create_group: {
        Args: { _name: string; _description?: string | null; _group_type?: string | null };
        Returns: string;
      };
      is_group_admin: { Args: { _group_id: string }; Returns: boolean };
      is_group_member: { Args: { _group_id: string }; Returns: boolean };
      shares_group_with: { Args: { _other_user: string }; Returns: boolean };
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
      respond_to_hangout: {
        Args: { _hangout_id: string; _status: 'confirmed' | 'declined' | 'maybe' | 'pending' };
        Returns: undefined;
      };
      set_handle: { Args: { _handle: string }; Returns: undefined };
      find_user_by_handle: {
        Args: { _handle: string };
        Returns: Array<{
          id: string;
          handle: string | null;
          first_name: string | null;
          display_name: string | null;
        }>;
      };
      request_friendship_by_handle: {
        Args: { _handle: string };
        Returns: 'request_sent' | 'already_friends' | 'request_pending' | 'auto_accepted' | string;
      };
      respond_to_friendship: {
        Args: { _other_user: string; _action: 'accept' | 'decline' };
        Returns: undefined;
      };
      unfriend: { Args: { _other_user: string }; Returns: undefined };
      add_friends_to_group: {
        Args: { _group_id: string; _user_ids: string[] };
        Returns: number;
      };
      google_calendar_status: {
        Args: Record<string, never>;
        Returns: Array<{
          connected: boolean;
          last_synced_at: string | null;
          last_sync_error: string | null;
        }>;
      };
      disconnect_google_calendar: {
        Args: Record<string, never>;
        Returns: undefined;
      };
      set_push_token: {
        Args: { _token: string | null };
        Returns: undefined;
      };
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
