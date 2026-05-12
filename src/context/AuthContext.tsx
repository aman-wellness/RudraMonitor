import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase, type Organization } from '../lib/supabase';

type AuthState = {
  session: Session | null;
  user: User | null;
  organization: Organization | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signInWithMicrosoft: () => Promise<void>;
  signUp: (args: { email: string; password: string; fullName: string }) => Promise<{ userId: string }>;
  signOut: () => Promise<void>;
  refreshOrganization: () => Promise<void>;
};

const AuthCtx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [loading, setLoading] = useState(true);

  // Track which user we've already loaded the org for. Without this,
  // every TOKEN_REFRESHED / SIGNED_IN-on-focus event re-fetches and creates
  // a brand-new organization object reference, which cascades through every
  // component that depends on it (useAgents, useActivityLogs, ...) and
  // re-fires their fetches mid-flight — causing endless "Loading…" states
  // when navigating.
  const loadedForUser = useRef<string | null>(null);

  const loadOrg = async (userId: string, force = false) => {
    if (!force && loadedForUser.current === userId) return;
    loadedForUser.current = userId;
    const { data } = await supabase
      .from('org_members')
      .select('org_id, organizations(*)')
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle();
    const raw = data?.organizations as unknown;
    const next = (Array.isArray(raw) ? raw[0] : raw) as Organization | null;
    // Only update state if the org id actually changed; identical orgs would
    // otherwise produce a new reference and re-render every consumer.
    setOrganization((prev) => {
      if (prev?.id === next?.id) return prev;
      return next ?? null;
    });
  };

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session);
      if (data.session?.user) await loadOrg(data.session.user.id);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      // Ignore noisy events that don't represent a real user transition.
      // INITIAL_SESSION fires right after getSession() above (duplicate);
      // TOKEN_REFRESHED fires on tab focus / hourly; USER_UPDATED on profile edits.
      if (event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
        setSession(s);
        return;
      }
      setSession(s);
      if (s?.user) {
        loadedForUser.current = null;  // force reload on actual sign-in
        void loadOrg(s.user.id);
      } else {
        loadedForUser.current = null;
        setOrganization(null);
      }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  };

  const signInWithGoogle = async () => {
    // After OAuth completes, land on /post-login — it resolves the role and
    // redirects to the right dashboard (super_admin / partner / customer).
    // First-time OAuth users with no org yet are routed to /complete-signup
    // by that handler so they can name their org and start the trial.
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/post-login` },
    });
    if (error) throw error;
  };

  const signInWithMicrosoft = async () => {
    // Personal vs work/school account routing is set in two places:
    //   1. Azure App Registration → Authentication → "Supported account types"
    //      = Multitenant + personal Microsoft accounts.
    //   2. Supabase → Auth → Providers → Azure → "Azure Tenant URL"
    //      = https://login.microsoftonline.com/common
    // Don't pass `tenant` in queryParams — it can collide with whatever
    // Supabase already builds, producing a malformed authorize URL (404).
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'azure',
      options: {
        redirectTo: `${window.location.origin}/post-login`,
        scopes: 'email openid profile',
        queryParams: { prompt: 'select_account' },
      },
    });
    if (error) throw error;
  };

  const signUp: AuthState['signUp'] = async ({ email, password, fullName }) => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName } },
    });
    if (error) throw error;
    if (!data.user) throw new Error('Signup did not return a user.');
    return { userId: data.user.id };
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setOrganization(null);
  };

  const refreshOrganization = async () => {
    if (session?.user) await loadOrg(session.user.id, true);
  };

  return (
    <AuthCtx.Provider
      value={{
        session,
        user: session?.user ?? null,
        organization,
        loading,
        signIn,
        signInWithGoogle,
        signInWithMicrosoft,
        signUp,
        signOut,
        refreshOrganization,
      }}
    >
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth() {
  const v = useContext(AuthCtx);
  if (!v) throw new Error('useAuth must be used inside <AuthProvider>');
  return v;
}
