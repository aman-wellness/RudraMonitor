import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';
import { useFeatures } from '@/lib/useFeatures';

/**
 * Trial countdown + grace banner.
 *
 * - During the 14-day trial: amber banner counting down to trial_ends_at.
 *   Includes "Switch plan" and "Request 15-day extension" actions.
 * - During the 7-day grace window (trial_ends_at < now() < trial_ends_at + 7d):
 *   rose banner counting down to auto-charge.
 * - When neither: renders nothing.
 */
export default function TrialGraceBanner() {
  const navigate = useNavigate();
  const { organization } = useAuth();
  const features = useFeatures();

  const [showModal, setShowModal] = useState(false);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submittedAt, setSubmittedAt] = useState<string | null>(null);
  const [pendingTimeExt, setPendingTimeExt] = useState<boolean>(false);

  // Discover whether the customer already has a pending 15-day extension
  // request so the banner CTA can disable / re-label.
  useEffect(() => {
    if (!organization?.id) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('trial_extension_requests')
        .select('id, status, kind, requested_at')
        .eq('org_id', organization.id)
        .eq('kind', 'time_extension')
        .eq('status', 'pending')
        .maybeSingle();
      if (!cancelled) setPendingTimeExt(!!data);
    })();
    return () => { cancelled = true; };
  }, [organization?.id, submittedAt]);

  if (features.loading || !features.on_trial || !features.trial_ends_at) return null;

  const trialEnd = new Date(features.trial_ends_at);
  const now = new Date();
  const graceEnd = new Date(trialEnd.getTime() + 7 * 24 * 60 * 60 * 1000);

  const inTrial = now < trialEnd;
  const inGrace = now >= trialEnd && now < graceEnd;
  if (!inTrial && !inGrace) return null;

  const daysToTrialEnd = Math.max(0, Math.ceil((trialEnd.getTime() - now.getTime()) / 86_400_000));
  const daysToGraceEnd = Math.max(0, Math.ceil((graceEnd.getTime() - now.getTime()) / 86_400_000));

  const submitExtension = async () => {
    if (!organization?.id) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in.');
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/trial-extension-request`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ kind: 'time_extension', days_requested: 15, reason: reason.trim() || undefined }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? 'Could not file request');
      setSubmittedAt(new Date().toISOString());
      setShowModal(false);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className={`mb-4 px-4 py-2.5 rounded-lg border flex flex-wrap items-center gap-3 text-xs ${
        inGrace
          ? 'bg-rose-500/10 border-rose-500/30 text-rose-300'
          : 'bg-amber-500/10 border-amber-500/30 text-amber-300'
      }`}>
        <i className={inGrace ? 'ri-error-warning-line text-lg' : 'ri-time-line text-lg'} />
        <span className="flex-1 min-w-0">
          {inTrial ? (
            <>
              <strong>Trial ends in {daysToTrialEnd} day{daysToTrialEnd === 1 ? '' : 's'}</strong>
              {' '}— you have a 7-day grace window after that before your card is charged automatically.
            </>
          ) : (
            <>
              <strong>Trial ended — auto-charge in {daysToGraceEnd} day{daysToGraceEnd === 1 ? '' : 's'}.</strong>
              {' '}Switch plans, request an extension, or sit tight to let billing kick in.
            </>
          )}
        </span>
        <button
          type="button"
          onClick={() => navigate('/subscription')}
          className="px-2.5 py-1 rounded-md bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/30 text-[11px] whitespace-nowrap"
        >
          View plans
        </button>
        <button
          type="button"
          disabled={pendingTimeExt || !!submittedAt}
          onClick={() => { setReason(''); setSubmitError(null); setShowModal(true); }}
          className="px-2.5 py-1 rounded-md bg-dark-700 border border-dark-600 text-gray-200 hover:bg-dark-600 disabled:opacity-50 disabled:cursor-not-allowed text-[11px] whitespace-nowrap"
        >
          {pendingTimeExt || submittedAt ? 'Extension requested' : 'Request 15-day extension'}
        </button>
      </div>

      {showModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center px-4" onClick={() => setShowModal(false)}>
          <div className="bg-dark-800 border border-dark-700 rounded-2xl p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-base font-semibold text-white mb-1">Request a 15-day trial extension</h2>
            <p className="text-xs text-gray-500 mb-4">
              A super admin will review and decide. While the request is pending you continue using the product normally.
            </p>
            <label className="block text-xs text-gray-400 mb-1.5">Reason (optional)</label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="Anything that helps us decide — e.g. 'still evaluating with our IT team'"
              maxLength={1000}
              className="w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500"
            />
            {submitError && (
              <p className="mt-2 text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded px-2 py-1.5">{submitError}</p>
            )}
            <div className="mt-4 flex items-center justify-end gap-2">
              <button type="button" onClick={() => setShowModal(false)} className="text-xs text-gray-400 hover:text-gray-200 px-3 py-1.5">
                Cancel
              </button>
              <button
                type="button"
                onClick={submitExtension}
                disabled={submitting}
                className="bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-dark-950 font-medium text-xs px-3 py-1.5 rounded-md"
              >
                {submitting ? 'Submitting…' : 'Submit request'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
