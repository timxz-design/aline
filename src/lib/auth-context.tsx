import { Session, User } from '@supabase/supabase-js';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { deregisterPushToken } from './push-notifications';
import { setSentryUser } from './sentry';
import { supabase } from './supabase';

type AuthState = {
  session: Session | null;
  user: User | null;
  loading: boolean;
};

type AuthContextValue = AuthState & {
  signInWithEmail: (email: string, password: string) => Promise<{ error: Error | null }>;
  signUpWithEmail: (
    email: string,
    password: string,
    firstName?: string
  ) => Promise<{ error: Error | null }>;
  /** Native Sign in with Apple. `cancelled` = user dismissed the sheet. */
  signInWithApple: () => Promise<{ error: Error | null; cancelled?: boolean }>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    session: null,
    user: null,
    loading: true,
  });

  useEffect(() => {
    // Hydrate from persisted storage
    supabase.auth.getSession().then(({ data }) => {
      setState({
        session: data.session,
        user: data.session?.user ?? null,
        loading: false,
      });
      setSentryUser(data.session?.user?.id ?? null);
    });

    // Subscribe to all future auth changes
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setState({
        session,
        user: session?.user ?? null,
        loading: false,
      });
      setSentryUser(session?.user?.id ?? null);
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      signInWithEmail: async (email, password) => {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        return { error: error as Error | null };
      },
      signUpWithEmail: async (email, password, firstName) => {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: firstName ? { first_name: firstName } : undefined,
          },
        });
        return { error: error as Error | null };
      },
      signInWithApple: async () => {
        try {
          // Apple gets the SHA-256 of the nonce; Supabase gets the raw value
          // and checks it against the hash embedded in the identity token.
          const rawNonce = Crypto.randomUUID();
          const hashedNonce = await Crypto.digestStringAsync(
            Crypto.CryptoDigestAlgorithm.SHA256,
            rawNonce
          );
          const credential = await AppleAuthentication.signInAsync({
            requestedScopes: [
              AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
              AppleAuthentication.AppleAuthenticationScope.EMAIL,
            ],
            nonce: hashedNonce,
          });
          if (!credential.identityToken) {
            return { error: new Error('Apple did not return an identity token.') };
          }
          const { data, error } = await supabase.auth.signInWithIdToken({
            provider: 'apple',
            token: credential.identityToken,
            nonce: rawNonce,
          });
          if (error) return { error: error as Error };

          // Apple only sends the name on the very first sign-in, and the
          // new-user trigger has already filled first_name from the (often
          // private-relay) email — overwrite it with the real name.
          const given = credential.fullName?.givenName?.trim();
          if (given && data.user) {
            const family = credential.fullName?.familyName?.trim();
            await supabase
              .from('profiles')
              .update({ first_name: given, display_name: family ? `${given} ${family}` : given })
              .eq('id', data.user.id);
          }
          return { error: null };
        } catch (e) {
          if ((e as { code?: string }).code === 'ERR_REQUEST_CANCELED') {
            return { error: null, cancelled: true };
          }
          return { error: e as Error };
        }
      },
      signOut: async () => {
        // Clear the push token first so this device stops receiving pushes
        // for the now-signed-out account.
        await deregisterPushToken();
        await supabase.auth.signOut();
      },
    }),
    [state]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
