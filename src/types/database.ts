// Auto-generated from Supabase schema (regenerated 2026-05-12).
// To regenerate: use the Supabase MCP `generate_typescript_types` tool,
// or run: npx supabase gen types typescript --project-id etsyyjwulqrbnogwjifh

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      activity_log: {
        Row: {
          actual_label: string | null
          checked_at: string
          confirmed_by: string | null
          created_at: string
          event_id: string | null
          expected_category: string | null
          id: string
          last_asked_at: string | null
          place_id: string | null
          result: string
          scheduled_end: string
          scheduled_start: string
          source_id: string | null
          source_kind: string
          user_id: string
        }
        Insert: {
          actual_label?: string | null
          checked_at?: string
          confirmed_by?: string | null
          created_at?: string
          event_id?: string | null
          expected_category?: string | null
          id?: string
          last_asked_at?: string | null
          place_id?: string | null
          result: string
          scheduled_end: string
          scheduled_start: string
          source_id?: string | null
          source_kind: string
          user_id: string
        }
        Update: {
          actual_label?: string | null
          checked_at?: string
          confirmed_by?: string | null
          created_at?: string
          event_id?: string | null
          expected_category?: string | null
          id?: string
          last_asked_at?: string | null
          place_id?: string | null
          result?: string
          scheduled_end?: string
          scheduled_start?: string
          source_id?: string | null
          source_kind?: string
          user_id?: string
        }
        Relationships: []
      }
      app_sessions: {
        Row: {
          duration_seconds: number | null
          id: string
          opened_at: string
          source: string
          user_id: string
        }
        Insert: {
          duration_seconds?: number | null
          id?: string
          opened_at?: string
          source?: string
          user_id: string
        }
        Update: {
          duration_seconds?: number | null
          id?: string
          opened_at?: string
          source?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "app_sessions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      behavioral_pings: {
        Row: {
          battery_level: number | null
          captured_at: string
          created_at: string
          geohash_8: string
          id: string
          motion_state: string | null
          source: string | null
          speed_mps: number | null
          user_id: string
        }
        Insert: {
          battery_level?: number | null
          captured_at: string
          created_at?: string
          geohash_8: string
          id?: string
          motion_state?: string | null
          source?: string | null
          speed_mps?: number | null
          user_id: string
        }
        Update: {
          battery_level?: number | null
          captured_at?: string
          created_at?: string
          geohash_8?: string
          id?: string
          motion_state?: string | null
          source?: string | null
          speed_mps?: number | null
          user_id?: string
        }
        Relationships: []
      }
      behavioral_summary: {
        Row: {
          archetype_text: string | null
          avg_daily_steps: number | null
          bedtime_minute: number | null
          chronotype: string | null
          data_quality: string
          updated_at: string
          user_id: string
          waketime_minute: number | null
          weekly_workout_count: number | null
        }
        Insert: {
          archetype_text?: string | null
          avg_daily_steps?: number | null
          bedtime_minute?: number | null
          chronotype?: string | null
          data_quality?: string
          updated_at?: string
          user_id: string
          waketime_minute?: number | null
          weekly_workout_count?: number | null
        }
        Update: {
          archetype_text?: string | null
          avg_daily_steps?: number | null
          bedtime_minute?: number | null
          chronotype?: string | null
          data_quality?: string
          updated_at?: string
          user_id?: string
          waketime_minute?: number | null
          weekly_workout_count?: number | null
        }
        Relationships: []
      }
      calendar_events: {
        Row: {
          created_at: string | null
          description: string | null
          end_at: string
          event_type: string | null
          external_id: string | null
          goal_id: string | null
          goal_plan_id: string | null
          google_synced_at: string | null
          hangout_id: string | null
          health_workout_id: string | null
          id: string
          is_movable: boolean
          local_event_id: string | null
          location: string | null
          original_start_at: string | null
          source: string | null
          start_at: string
          title: string | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          end_at: string
          event_type?: string | null
          external_id?: string | null
          goal_id?: string | null
          goal_plan_id?: string | null
          google_synced_at?: string | null
          hangout_id?: string | null
          health_workout_id?: string | null
          id?: string
          is_movable?: boolean
          local_event_id?: string | null
          location?: string | null
          original_start_at?: string | null
          source?: string | null
          start_at: string
          title?: string | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          description?: string | null
          end_at?: string
          event_type?: string | null
          external_id?: string | null
          goal_id?: string | null
          goal_plan_id?: string | null
          google_synced_at?: string | null
          hangout_id?: string | null
          health_workout_id?: string | null
          id?: string
          is_movable?: boolean
          local_event_id?: string | null
          location?: string | null
          original_start_at?: string | null
          source?: string | null
          start_at?: string
          title?: string | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "calendar_events_hangout_id_fkey"
            columns: ["hangout_id"]
            isOneToOne: false
            referencedRelation: "hangouts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "calendar_events_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      change_sets: {
        Row: {
          chat_message_id: string | null
          created_at: string
          expires_at: string
          id: string
          operations: Json
          reasoning: string | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          chat_message_id?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          operations: Json
          reasoning?: string | null
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          chat_message_id?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          operations?: Json
          reasoning?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "change_sets_chat_message_id_fkey"
            columns: ["chat_message_id"]
            isOneToOne: false
            referencedRelation: "chat_messages"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_messages: {
        Row: {
          content: string
          context_snapshot: Json | null
          event_ids: string[] | null
          created_at: string | null
          extracted_data: Json | null
          goal_plan_id: string | null
          id: string
          image_url: string | null
          input_tokens: number | null
          model: string | null
          output_tokens: number | null
          role: string
          user_id: string
        }
        Insert: {
          content: string
          context_snapshot?: Json | null
          event_ids?: string[] | null
          created_at?: string | null
          extracted_data?: Json | null
          goal_plan_id?: string | null
          id?: string
          image_url?: string | null
          input_tokens?: number | null
          model?: string | null
          output_tokens?: number | null
          role: string
          user_id: string
        }
        Update: {
          content?: string
          context_snapshot?: Json | null
          event_ids?: string[] | null
          created_at?: string | null
          extracted_data?: Json | null
          goal_plan_id?: string | null
          id?: string
          image_url?: string | null
          input_tokens?: number | null
          model?: string | null
          output_tokens?: number | null
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_messages_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      events: {
        Row: {
          category: string | null
          created_at: string
          created_by: string
          description: string | null
          ends_at: string | null
          id: string
          image_url: string | null
          last_seen_at: string
          lat: number | null
          lon: number | null
          price_text: string | null
          source: string
          source_id: string | null
          starts_at: string
          status: string
          title: string
          updated_at: string
          url: string | null
          venue_id: string | null
          venue_text: string | null
          visibility: string
        }
        Insert: {
          category?: string | null
          created_at?: string
          created_by: string
          description?: string | null
          ends_at?: string | null
          id?: string
          image_url?: string | null
          last_seen_at?: string
          lat?: number | null
          lon?: number | null
          price_text?: string | null
          source?: string
          source_id?: string | null
          starts_at: string
          status?: string
          title: string
          updated_at?: string
          url?: string | null
          venue_id?: string | null
          venue_text?: string | null
          visibility?: string
        }
        Update: {
          category?: string | null
          created_at?: string
          created_by?: string
          description?: string | null
          ends_at?: string | null
          id?: string
          image_url?: string | null
          last_seen_at?: string
          lat?: number | null
          lon?: number | null
          price_text?: string | null
          source?: string
          source_id?: string | null
          starts_at?: string
          status?: string
          title?: string
          updated_at?: string
          url?: string | null
          venue_id?: string | null
          venue_text?: string | null
          visibility?: string
        }
        Relationships: [
          {
            foreignKeyName: "events_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      venues: {
        Row: {
          address: string | null
          category: string | null
          claimed_by: string | null
          created_at: string
          created_by: string | null
          google_place_id: string | null
          id: string
          lat: number | null
          lon: number | null
          name: string
          updated_at: string
        }
        Insert: {
          address?: string | null
          category?: string | null
          claimed_by?: string | null
          created_at?: string
          created_by?: string | null
          google_place_id?: string | null
          id?: string
          lat?: number | null
          lon?: number | null
          name: string
          updated_at?: string
        }
        Update: {
          address?: string | null
          category?: string | null
          claimed_by?: string | null
          created_at?: string
          created_by?: string | null
          google_place_id?: string | null
          id?: string
          lat?: number | null
          lon?: number | null
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      friendships: {
        Row: {
          created_at: string | null
          requested_by: string | null
          status: string
          tier_a: string
          tier_b: string
          updated_at: string | null
          user_a: string
          user_b: string
        }
        Insert: {
          created_at?: string | null
          requested_by?: string | null
          status: string
          tier_a?: string
          tier_b?: string
          updated_at?: string | null
          user_a: string
          user_b: string
        }
        Update: {
          created_at?: string | null
          requested_by?: string | null
          status?: string
          tier_a?: string
          tier_b?: string
          updated_at?: string | null
          user_a?: string
          user_b?: string
        }
        Relationships: [
          {
            foreignKeyName: "friendships_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "friendships_user_a_fkey"
            columns: ["user_a"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "friendships_user_b_fkey"
            columns: ["user_b"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      goal_plans: {
        Row: {
          committed_at: string | null
          created_at: string
          goal_id: string
          id: string
          plan_spec: Json
          prev_spec: Json | null
          rationale: string | null
          status: string
          updated_at: string
          user_id: string
          version: number
        }
        Insert: {
          committed_at?: string | null
          created_at?: string
          goal_id: string
          id?: string
          plan_spec?: Json
          prev_spec?: Json | null
          rationale?: string | null
          status?: string
          updated_at?: string
          user_id: string
          version?: number
        }
        Update: {
          committed_at?: string | null
          created_at?: string
          goal_id?: string
          id?: string
          plan_spec?: Json
          prev_spec?: Json | null
          rationale?: string | null
          status?: string
          updated_at?: string
          user_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "goal_plans_goal_id_fkey"
            columns: ["goal_id"]
            isOneToOne: false
            referencedRelation: "goals"
            referencedColumns: ["id"]
          },
        ]
      }
      goals: {
        Row: {
          category: string | null
          created_at: string | null
          id: string
          is_aspirational: boolean | null
          last_completed_at: string | null
          notes: string | null
          status: string | null
          target_date: string | null
          target_per_week: number | null
          title: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          category?: string | null
          created_at?: string | null
          id?: string
          is_aspirational?: boolean | null
          last_completed_at?: string | null
          notes?: string | null
          status?: string | null
          target_date?: string | null
          target_per_week?: number | null
          title: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          category?: string | null
          created_at?: string | null
          id?: string
          is_aspirational?: boolean | null
          last_completed_at?: string | null
          notes?: string | null
          status?: string | null
          target_date?: string | null
          target_per_week?: number | null
          title?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "goals_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      google_oauth_tokens: {
        Row: {
          access_token: string
          created_at: string | null
          last_sync_error: string | null
          last_synced_at: string | null
          refresh_token: string
          scope: string | null
          token_expires_at: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          access_token: string
          created_at?: string | null
          last_sync_error?: string | null
          last_synced_at?: string | null
          refresh_token: string
          scope?: string | null
          token_expires_at: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          access_token?: string
          created_at?: string | null
          last_sync_error?: string | null
          last_synced_at?: string | null
          refresh_token?: string
          scope?: string | null
          token_expires_at?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "google_oauth_tokens_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      group_members: {
        Row: {
          group_id: string
          joined_at: string | null
          muted_until: string | null
          role: string | null
          trust_tier: string | null
          user_id: string
        }
        Insert: {
          group_id: string
          joined_at?: string | null
          muted_until?: string | null
          role?: string | null
          trust_tier?: string | null
          user_id: string
        }
        Update: {
          group_id?: string
          joined_at?: string | null
          muted_until?: string | null
          role?: string | null
          trust_tier?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "group_members_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "group_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      groups: {
        Row: {
          created_at: string | null
          created_by: string
          description: string | null
          group_type: string | null
          id: string
          name: string
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          created_by: string
          description?: string | null
          group_type?: string | null
          id?: string
          name: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          created_by?: string
          description?: string | null
          group_type?: string | null
          id?: string
          name?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "groups_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      hangout_responses: {
        Row: {
          hangout_id: string
          note: string | null
          responded_at: string | null
          status: string | null
          user_id: string
        }
        Insert: {
          hangout_id: string
          note?: string | null
          responded_at?: string | null
          status?: string | null
          user_id: string
        }
        Update: {
          hangout_id?: string
          note?: string | null
          responded_at?: string | null
          status?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "hangout_responses_hangout_id_fkey"
            columns: ["hangout_id"]
            isOneToOne: false
            referencedRelation: "hangouts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hangout_responses_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      hangouts: {
        Row: {
          confidence: number | null
          created_at: string | null
          description: string | null
          direct_user_id: string | null
          group_id: string | null
          id: string
          min_attendees: number
          proposed_by: string
          proposed_end: string | null
          proposed_start: string | null
          reasoning: string | null
          status: string | null
          title: string
          updated_at: string | null
          venue_address: string | null
          venue_lat: number | null
          venue_lng: number | null
          venue_name: string | null
        }
        Insert: {
          confidence?: number | null
          created_at?: string | null
          description?: string | null
          direct_user_id?: string | null
          group_id?: string | null
          id?: string
          min_attendees?: number
          proposed_by: string
          proposed_end?: string | null
          proposed_start?: string | null
          reasoning?: string | null
          status?: string | null
          title: string
          updated_at?: string | null
          venue_address?: string | null
          venue_lat?: number | null
          venue_lng?: number | null
          venue_name?: string | null
        }
        Update: {
          confidence?: number | null
          created_at?: string | null
          description?: string | null
          direct_user_id?: string | null
          group_id?: string | null
          id?: string
          min_attendees?: number
          proposed_by?: string
          proposed_end?: string | null
          proposed_start?: string | null
          reasoning?: string | null
          status?: string | null
          title?: string
          updated_at?: string | null
          venue_address?: string | null
          venue_lat?: number | null
          venue_lng?: number | null
          venue_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "hangouts_direct_user_id_fkey"
            columns: ["direct_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hangouts_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hangouts_proposed_by_fkey"
            columns: ["proposed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      health_workouts: {
        Row: {
          activity_type: string
          avg_heart_rate: number | null
          device: string | null
          distance_m: number | null
          duration_min: number | null
          ended_at: string
          energy_kcal: number | null
          external_id: string
          id: string
          imported_at: string
          match_kind: string | null
          matched_event_id: string | null
          matched_goal_id: string | null
          max_heart_rate: number | null
          raw_activity_type: string | null
          reconciled_at: string | null
          source: string
          started_at: string
          user_id: string
        }
        Insert: {
          activity_type: string
          avg_heart_rate?: number | null
          device?: string | null
          distance_m?: number | null
          duration_min?: number | null
          ended_at: string
          energy_kcal?: number | null
          external_id: string
          id?: string
          imported_at?: string
          match_kind?: string | null
          matched_event_id?: string | null
          matched_goal_id?: string | null
          max_heart_rate?: number | null
          raw_activity_type?: string | null
          reconciled_at?: string | null
          source?: string
          started_at: string
          user_id: string
        }
        Update: {
          activity_type?: string
          avg_heart_rate?: number | null
          device?: string | null
          distance_m?: number | null
          duration_min?: number | null
          ended_at?: string
          energy_kcal?: number | null
          external_id?: string
          id?: string
          imported_at?: string
          match_kind?: string | null
          matched_event_id?: string | null
          matched_goal_id?: string | null
          max_heart_rate?: number | null
          raw_activity_type?: string | null
          reconciled_at?: string | null
          source?: string
          started_at?: string
          user_id?: string
        }
        Relationships: []
      }
      interests: {
        Row: {
          active: boolean | null
          confidence: number | null
          created_at: string | null
          id: string
          key: string
          source: string | null
          updated_at: string | null
          user_id: string
          value: Json
        }
        Insert: {
          active?: boolean | null
          confidence?: number | null
          created_at?: string | null
          id?: string
          key: string
          source?: string | null
          updated_at?: string | null
          user_id: string
          value: Json
        }
        Update: {
          active?: boolean | null
          confidence?: number | null
          created_at?: string | null
          id?: string
          key?: string
          source?: string | null
          updated_at?: string | null
          user_id?: string
          value?: Json
        }
        Relationships: [
          {
            foreignKeyName: "interests_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      places: {
        Row: {
          category: string | null
          centroid_lat: number | null
          centroid_lon: number | null
          confidence: number | null
          created_at: string
          first_seen: string
          geohash_5: string
          geohash_7: string
          google_place_id: string | null
          id: string
          inference_status: string
          is_hidden: boolean
          is_sensitive: boolean
          last_asked_at: string | null
          last_seen: string
          name: string | null
          ping_count: number
          primary_type: string | null
          total_dwell_minutes: number | null
          updated_at: string
          user_id: string
          user_label: string | null
          visit_count: number
        }
        Insert: {
          category?: string | null
          centroid_lat?: number | null
          centroid_lon?: number | null
          confidence?: number | null
          created_at?: string
          first_seen?: string
          geohash_5: string
          geohash_7: string
          google_place_id?: string | null
          id?: string
          inference_status?: string
          is_hidden?: boolean
          is_sensitive?: boolean
          last_asked_at?: string | null
          last_seen?: string
          name?: string | null
          ping_count?: number
          primary_type?: string | null
          total_dwell_minutes?: number | null
          updated_at?: string
          user_id: string
          user_label?: string | null
          visit_count?: number
        }
        Update: {
          category?: string | null
          centroid_lat?: number | null
          centroid_lon?: number | null
          confidence?: number | null
          created_at?: string
          first_seen?: string
          geohash_5?: string
          geohash_7?: string
          google_place_id?: string | null
          id?: string
          inference_status?: string
          is_hidden?: boolean
          is_sensitive?: boolean
          last_asked_at?: string | null
          last_seen?: string
          name?: string | null
          ping_count?: number
          primary_type?: string | null
          total_dwell_minutes?: number | null
          updated_at?: string
          user_id?: string
          user_label?: string | null
          visit_count?: number
        }
        Relationships: []
      }
      profiles: {
        Row: {
          archetype_summary: string | null
          created_at: string | null
          display_name: string | null
          expo_push_token: string | null
          first_name: string | null
          handle: string | null
          health_connected: boolean
          id: string
          onboarding_complete: boolean | null
          push_notifications_enabled: boolean
          push_token_updated_at: string | null
          social_openness: string | null
          timezone: string | null
          updated_at: string | null
        }
        Insert: {
          archetype_summary?: string | null
          created_at?: string | null
          display_name?: string | null
          expo_push_token?: string | null
          first_name?: string | null
          handle?: string | null
          health_connected?: boolean
          id: string
          onboarding_complete?: boolean | null
          push_notifications_enabled?: boolean
          push_token_updated_at?: string | null
          social_openness?: string | null
          timezone?: string | null
          updated_at?: string | null
        }
        Update: {
          archetype_summary?: string | null
          created_at?: string | null
          display_name?: string | null
          expo_push_token?: string | null
          first_name?: string | null
          handle?: string | null
          health_connected?: boolean
          id?: string
          onboarding_complete?: boolean | null
          push_notifications_enabled?: boolean
          push_token_updated_at?: string | null
          social_openness?: string | null
          timezone?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      reminders: {
        Row: {
          content: string
          created_at: string
          id: string
          remind_at: string
          status: string
          user_id: string
        }
        Insert: {
          content: string
          created_at?: string
          id?: string
          remind_at: string
          status?: string
          user_id: string
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          remind_at?: string
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "reminders_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      routines: {
        Row: {
          active: boolean
          category: string | null
          consistency: number | null
          created_at: string
          day_of_week: number | null
          end_minute: number | null
          id: string
          inference_status: string
          last_asked_at: string | null
          last_observed: string | null
          place_id: string | null
          start_minute: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          active?: boolean
          category?: string | null
          consistency?: number | null
          created_at?: string
          day_of_week?: number | null
          end_minute?: number | null
          id?: string
          inference_status?: string
          last_asked_at?: string | null
          last_observed?: string | null
          place_id?: string | null
          start_minute?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          active?: boolean
          category?: string | null
          consistency?: number | null
          created_at?: string
          day_of_week?: number | null
          end_minute?: number | null
          id?: string
          inference_status?: string
          last_asked_at?: string | null
          last_observed?: string | null
          place_id?: string | null
          start_minute?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "routines_place_id_fkey"
            columns: ["place_id"]
            isOneToOne: false
            referencedRelation: "places"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      _coordinated_event_payload: {
        Args: {
          _h: Database["public"]["Tables"]["hangouts"]["Row"]
          _user_id: string
        }
        Returns: Json
      }
      add_friends_to_group: {
        Args: { _group_id: string; _user_ids: string[] }
        Returns: number
      }
      apply_change_set: { Args: { _id: string }; Returns: Json }
      resolve_activity_check: {
        Args: { _id: string; _result: string; _actual_label?: string }
        Returns: undefined
      }
      are_friends: { Args: { _a: string; _b: string }; Returns: boolean }
      cancel_hangout: { Args: { _hangout_id: string }; Returns: undefined }
      commit_goal_plan: { Args: { _goal_id: string }; Returns: Json }
      create_group: {
        Args: { _description?: string; _group_type?: string; _name: string }
        Returns: string
      }
      disconnect_google_calendar: { Args: never; Returns: undefined }
      find_mutual_slots: {
        Args: {
          _duration_minutes?: number
          _earliest: string
          _earliest_hour?: number
          _latest: string
          _latest_hour?: number
          _max_results?: number
          _time_preference?: string
          _user_ids: string[]
        }
        Returns: Json
      }
      find_user_by_handle: {
        Args: { _handle: string }
        Returns: {
          display_name: string
          first_name: string
          handle: string
          id: string
        }[]
      }
      google_calendar_status: {
        Args: never
        Returns: {
          connected: boolean
          last_sync_error: string
          last_synced_at: string
        }[]
      }
      is_group_admin: { Args: { _group_id: string }; Returns: boolean }
      is_group_member: { Args: { _group_id: string }; Returns: boolean }
      mark_curiosity_asked: {
        Args: { _id: string; _kind: string }
        Returns: undefined
      }
      mark_goal_done: { Args: { _goal_id: string; _date?: string }; Returns: Json }
      next_curiosity_item: {
        Args: never
        Returns: {
          id: string
          kind: string
          payload: Json
        }[]
      }
      propose_direct_hangout: {
        Args: {
          _confidence?: number
          _description?: string
          _direct_user_id: string
          _proposed_end?: string
          _proposed_start: string
          _reasoning: string
          _title: string
          _venue_address?: string
          _venue_name?: string
        }
        Returns: string
      }
      propose_hangout:
        | {
            Args: {
              _confidence?: number
              _description?: string
              _group_id: string
              _proposed_end?: string
              _proposed_start: string
              _reasoning: string
              _title: string
              _venue_address?: string
              _venue_name?: string
            }
            Returns: string
          }
        | {
            Args: {
              _confidence?: number
              _description?: string
              _group_id: string
              _min_attendees?: number
              _proposed_end?: string
              _proposed_start: string
              _reasoning: string
              _title: string
              _venue_address?: string
              _venue_name?: string
            }
            Returns: string
          }
      reject_change_set: { Args: { _id: string }; Returns: undefined }
      request_friendship_by_handle: {
        Args: { _handle: string }
        Returns: string
      }
      reconcile_health_workouts: {
        Args: { _max?: number }
        Returns: Json
      }
      respond_to_friendship: {
        Args: { _action: string; _other_user: string }
        Returns: undefined
      }
      respond_to_hangout: {
        Args: { _hangout_id: string; _status: string }
        Returns: undefined
      }
      send_push_to_users: {
        Args: {
          _body: string
          _data?: Json
          _title: string
          _user_ids: string[]
        }
        Returns: undefined
      }
      set_friend_tier: { Args: { _other_user: string; _tier: string }; Returns: undefined }
      set_handle: { Args: { _handle: string }; Returns: undefined }
      set_push_token: { Args: { _token: string }; Returns: undefined }
      shares_group_with: { Args: { _other_user: string }; Returns: boolean }
      unfriend: { Args: { _other_user: string }; Returns: undefined }
      update_hangout: {
        Args: {
          _hangout_id: string
          _new_description?: string
          _new_end?: string
          _new_start?: string
          _new_title?: string
          _new_venue_addr?: string
          _new_venue_name?: string
        }
        Returns: undefined
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const

// ---------- Convenience aliases used throughout the app ----------

export type Profile = Database["public"]["Tables"]["profiles"]["Row"]
export type Hangout = Database["public"]["Tables"]["hangouts"]["Row"]
export type HangoutResponse = Database["public"]["Tables"]["hangout_responses"]["Row"]
export type CalendarEvent = Database["public"]["Tables"]["calendar_events"]["Row"]
export type Group = Database["public"]["Tables"]["groups"]["Row"]
export type GroupMember = Database["public"]["Tables"]["group_members"]["Row"]
export type Friendship = Database["public"]["Tables"]["friendships"]["Row"]
export type ChatMessage = Database["public"]["Tables"]["chat_messages"]["Row"]
export type Goal = Database["public"]["Tables"]["goals"]["Row"]
export type GoalPlan = Database["public"]["Tables"]["goal_plans"]["Row"]
export type LocalEvent = Database["public"]["Tables"]["events"]["Row"]
export type HealthWorkout = Database["public"]["Tables"]["health_workouts"]["Row"]
export type Interest = Database["public"]["Tables"]["interests"]["Row"]
export type ChangeSet = Database["public"]["Tables"]["change_sets"]["Row"]
export type BehavioralPing = Database["public"]["Tables"]["behavioral_pings"]["Row"]
export type BehavioralSummary = Database["public"]["Tables"]["behavioral_summary"]["Row"]
export type Place = Database["public"]["Tables"]["places"]["Row"]
export type Routine = Database["public"]["Tables"]["routines"]["Row"]

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
  goal_plan_id?: string;
  reasoning?: string;
};

export type ChangeSetOperation = ChangeSetMoveOp | ChangeSetCreateOp;
