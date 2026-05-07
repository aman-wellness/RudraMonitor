import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
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

  const loadOrg = async (userId: string) => {
    const { data } = await supabase
      .from('org_members')
      .select('org_id, organizations(*)')
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle();
    const org = data?.organizations as unknown;
    if (Array.isArray(org)) setOrganization((org[0] as Organization) ?? null);
    else setOrganization((org as Organization | null) ?? null);
  };

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session);
      if (data.session?.user) await loadOrg(data.session.user.id);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange(async (_e, s) => {
      setSession(s);
      if (s?.user) await loadOrg(s.user.id);
      else setOrganization(null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  };

  const signInWithGoogle = async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/dashboard` },
    });
    if (error) throw error;
  };

  const signInWithMicrosoft = async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'azure',
      options: {
        redirectTo: `${window.location.origin}/dashboard`,
        scopes: 'email openid profile',
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
    if (session?.user) await loadOrg(session.user.id);
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
