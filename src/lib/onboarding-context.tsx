import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { InterestTile, SocialOpenness } from './onboarding-data';
import { supabase } from './supabase';

type OnboardingState = {
  handle: string;
  selectedInterests: InterestTile[];
  socialOpenness: SocialOpenness;
};

type OnboardingContextValue = OnboardingState & {
  setHandle: (h: string) => void;
  toggleInterest: (tile: InterestTile) => void;
  setSocialOpenness: (value: SocialOpenness) => void;
  /** Persist everything in one shot, mark onboarding_complete=true. */
  complete: (userId: string) => Promise<{ error: Error | null }>;
};

const OnboardingContext = createContext<OnboardingContextValue | undefined>(
  undefined
);

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const [handle, setHandle] = useState('');
  const [selectedInterests, setSelectedInterests] = useState<InterestTile[]>([]);
  const [socialOpenness, setSocialOpenness] = useState<SocialOpenness>('crew_only');

  const toggleInterest = useCallback((tile: InterestTile) => {
    setSelectedInterests((prev) => {
      const isSelected = prev.some((t) => t.label === tile.label);
      return isSelected
        ? prev.filter((t) => t.label !== tile.label)
        : [...prev, tile];
    });
  }, []);

  const complete = useCallback(
    async (userId: string): Promise<{ error: Error | null }> => {
      // Set the handle first via RPC (validates uniqueness + format).
      // If this fails the user stays on the openness screen — we can show
      // the error inline.
      if (handle.trim()) {
        const { error: handleErr } = await supabase.rpc('set_handle', {
          _handle: handle.trim().toLowerCase(),
        });
        if (handleErr) {
          return { error: handleErr as Error };
        }
      }

      // Update profile + insert one interest row per selected tile, in
      // parallel. We tolerate partial success on interests so a flaky write
      // doesn't strand the user pre-onboarding.
      const profileUpdate = supabase
        .from('profiles')
        .update({
          social_openness: socialOpenness,
          onboarding_complete: true,
          // The phone's own time zone from the first minute — the column
          // default is a placeholder, and every server-side time (pushes,
          // quiet hours, "yesterday") is computed in this.
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        })
        .eq('id', userId);

      const interestInserts =
        selectedInterests.length > 0
          ? supabase.from('interests').insert(
              selectedInterests.map((tile) => ({
                user_id: userId,
                key: tile.category,
                value: {
                  label: tile.label,
                  icon: tile.icon,
                  blurb: tile.blurb ?? null,
                },
                source: 'onboarding',
                confidence: 0.95,
              }))
            )
          : Promise.resolve({ error: null } as { error: Error | null });

      const [profRes, intRes] = await Promise.all([
        profileUpdate,
        interestInserts,
      ]);

      if (profRes.error) {
        return { error: profRes.error as Error };
      }
      if ('error' in intRes && intRes.error) {
        // Non-fatal — log and continue.
        console.warn('Interests insert failed:', intRes.error.message);
      }
      return { error: null };
    },
    [handle, selectedInterests, socialOpenness]
  );

  const value = useMemo<OnboardingContextValue>(
    () => ({
      handle,
      selectedInterests,
      socialOpenness,
      setHandle,
      toggleInterest,
      setSocialOpenness,
      complete,
    }),
    [handle, selectedInterests, socialOpenness, toggleInterest, complete]
  );

  return (
    <OnboardingContext.Provider value={value}>
      {children}
    </OnboardingContext.Provider>
  );
}

export function useOnboarding(): OnboardingContextValue {
  const ctx = useContext(OnboardingContext);
  if (!ctx) throw new Error('useOnboarding must be used inside <OnboardingProvider>');
  return ctx;
}
