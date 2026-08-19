import { useEffect, useState } from 'react';
import { supabase, type DlpAlertRecipient, type DlpSettings, type DlpSeverity } from '@/lib/supabase';
import { confirmDialog, notify } from '@/lib/notify';
import { SEVERITIES, sevTone } from '../useDlp';

/* DLP configuration.
 *
 * Behaviour fixes here, not just paint:
 *   • The domain list and the AI policy saved on blur with no button and no
 *     feedback — you clicked away and had no idea whether it stuck. Both now
 *     have an explicit Save that appears once the value differs, and report
 *     through the toast layer.
 *   • Deleting an alert recipient happened instantly on one click, with no
 *     confirmation, on a security-notification list.
 *   • Errors were a bare red line above the panels; they're toasts now, like
 *     everywhere else in the app.
 */

export default function SettingsPanel({
  orgId,
  settings,
  onSaved,
}: {
  orgId: string | null;
  settings: DlpSettings | null;
  onSaved: () => void;
}) {
  const [recipients, setRecipients] = useState<DlpAlertRecipient[]>([]);
  const [busy, setBusy] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');

  // Draft copies so the inputs are editable and comparable against what's saved.
  const [domains, setDomains] = useState('');
  const [policy, setPolicy] = useState('');
  useEffect(() => {
    setDomains((settings?.authorized_domains ?? []).join(', '));
    setPolicy(settings?.ai_policy_prompt ?? '');
  }, [settings]);

  const loadRecipients = async () => {
    if (!orgId) return;
    const { data } = await supabase
      .from('dlp_alert_recipients')
      .select('*')
      .eq('org_id', orgId)
      .order('created_at');
    setRecipients((data as DlpAlertRecipient[]) ?? []);
  };
  useEffect(() => { void loadRecipients(); }, [orgId]); // eslint-disable-line react-hooks/exhaustive-deps

  const update = async (patch: Partial<DlpSettings>, label: string) => {
    if (!orgId || !settings) return;
    setBusy(true);
    const { error } = await supabase.from('dlp_settings').upsert({ ...settings, ...patch, org_id: orgId });
    setBusy(false);
    if (error) { notify.fail(`Could not save ${label}`, error); return; }
    notify.success(`${label} saved`);
    onSaved();
  };

  const addRecipient = async () => {
    const email = newEmail.trim().toLowerCase();
    if (!orgId || !email) return;
    setBusy(true);
    const { error } = await supabase.from('dlp_alert_recipients').insert({
      org_id: orgId,
      email,
      full_name: newName.trim() || null,
      // New recipients start on the two severities that warrant waking someone.
      severities: ['high', 'critical'],
    });
    setBusy(false);
    if (error) { notify.fail('Could not add recipient', error); return; }
    setNewEmail(''); setNewName('');
    notify.success(`${email} added`, { description: 'Will receive high and critical alerts.' });
    await loadRecipients();
  };

  const removeRecipient = async (rec: DlpAlertRecipient) => {
    const ok = await confirmDialog({
      title: `Remove ${rec.full_name ?? rec.email}?`,
      body: 'They will stop receiving DLP alert emails. Past alerts are unaffected.',
      confirmLabel: 'Remove recipient',
      tone: 'danger',
    });
    if (!ok) return;
    const { error } = await supabase.from('dlp_alert_recipients').delete().eq('id', rec.id);
    if (error) { notify.fail('Could not remove recipient', error); return; }
    notify.success(`${rec.email} removed`);
    await loadRecipients();
  };

  const toggleSeverity = async (rec: DlpAlertRecipient, sev: DlpSeverity) => {
    const next = rec.severities.includes(sev)
      ? rec.severities.filter((s) => s !== sev)
      : [...rec.severities, sev];
    // Optimistic — the chips are a rapid-fire control and a round-trip per click
    // made them feel broken.
    setRecipients((p) => p.map((r) => (r.id === rec.id ? { ...r, severities: next } : r)));
    const { error } = await supabase
      .from('dlp_alert_recipients')
      .update({ severities: next })
      .eq('id', rec.id);
    if (error) {
      notify.fail('Could not change severities', error);
      await loadRecipients();
    }
  };

  if (!settings) {
    return <div className="panel p-8 text-center text-[12px] t3">Loading settings…</div>;
  }

  const savedDomains = (settings.authorized_domains ?? []).join(', ');
  const domainsDirty = domains.trim() !== savedDomains;
  const policyDirty = policy.trim() !== (settings.ai_policy_prompt ?? '').trim();

  const channels: { key: keyof DlpSettings; label: string; sub: string; icon: string; on: boolean }[] = [
    {
      key: 'usb_enabled',
      label: 'USB transfers',
      sub: 'Files copied to or from removable drives. Always flagged — no domain whitelist applies.',
      icon: 'ri-usb-line',
      on: settings.usb_enabled,
    },
    {
      key: 'email_enabled',
      label: 'Email attachments',
      sub: 'Files attached in Gmail, Yahoo, Outlook or Rediffmail webmail.',
      icon: 'ri-mail-send-line',
      on: settings.email_enabled,
    },
    {
      key: 'clipboard_enabled',
      label: 'Clipboard exfiltration',
      sub: 'Large copy-paste of sensitive content into mail or chat apps. Beta.',
      icon: 'ri-clipboard-line',
      on: settings.clipboard_enabled,
    },
  ];

  return (
    <div className="space-y-2.5">
      <div className="panel">
        <header className="panel-head">
          <h3 className="panel-title">What to monitor</h3>
          <span className="label">{channels.filter((c) => c.on).length} of {channels.length} on</span>
        </header>
        <div className="panel-body space-y-2">
          {channels.map((c) => (
            <div key={c.key} className="ctl-row">
              <div className="flex items-center gap-3 min-w-0">
                <span
                  className={`ctl-icon ${c.on ? 'is-on' : ''}`}
                  style={{ ['--tg' as string]: 'var(--d-accent-2)' }}
                >
                  <i className={c.icon} />
                </span>
                <div className="min-w-0">
                  <p className="text-[12px] t1 font-medium">{c.label}</p>
                  <p className="text-[10.5px] t3">{c.sub}</p>
                </div>
              </div>
              <button
                onClick={() => void update({ [c.key]: !c.on } as Partial<DlpSettings>, c.label)}
                disabled={busy}
                className={`toggle ${c.on ? 'is-on' : ''}`}
                style={{ ['--tg' as string]: 'var(--d-accent-2)' }}
                aria-label={`Toggle ${c.label}`}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="panel">
        <header className="panel-head">
          <h3 className="panel-title">Authorized email domains</h3>
          {domainsDirty && <span className="label t-warning">unsaved</span>}
        </header>
        <div className="panel-body space-y-2">
          <p className="text-[11px] t3 leading-relaxed">
            Every personal-mail attachment is flagged by default. Recipients at a listed domain are
            treated as low severity and authorized. Comma-separated.
          </p>
          <input
            value={domains}
            onChange={(e) => setDomains(e.target.value)}
            placeholder="company.com, partner.in, client.co"
            className="filter-date w-full"
          />
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-[10.5px] t3">
              {(settings.authorized_domains ?? []).length === 0
                ? 'No domains listed — every external recipient is treated as unauthorized.'
                : `${settings.authorized_domains.length} domain${settings.authorized_domains.length === 1 ? '' : 's'} whitelisted.`}
            </p>
            {domainsDirty && (
              <span className="flex items-center gap-1.5">
                <button onClick={() => setDomains(savedDomains)} className="chip chip-quiet text-[10.5px]">
                  Cancel
                </button>
                <button
                  onClick={() => void update(
                    { authorized_domains: domains.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) },
                    'Authorized domains',
                  )}
                  disabled={busy}
                  className="chip chip-accent text-[10.5px]"
                >
                  <i className="ri-check-line" />
                  Save domains
                </button>
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="panel">
        <header className="panel-head">
          <h3 className="panel-title">Custom AI policy</h3>
          {policyDirty && <span className="label t-warning">unsaved</span>}
        </header>
        <div className="panel-body space-y-2">
          <p className="text-[11px] t3 leading-relaxed">
            Optional. By default every USB transfer and every personal-mail attachment is tracked
            regardless of content — add rules here only to classify more strictly.
          </p>
          <textarea
            value={policy}
            onChange={(e) => setPolicy(e.target.value)}
            rows={3}
            placeholder='e.g. "Mark CRITICAL when the file name contains payroll, customer_db, source_code or NDA."'
            className="filter-date w-full"
            style={{ height: 'auto', padding: '7px 9px', lineHeight: 1.5 }}
          />
          {policyDirty && (
            <div className="flex items-center justify-end gap-1.5">
              <button
                onClick={() => setPolicy(settings.ai_policy_prompt ?? '')}
                className="chip chip-quiet text-[10.5px]"
              >
                Cancel
              </button>
              <button
                onClick={() => void update({ ai_policy_prompt: policy.trim() || null }, 'AI policy')}
                disabled={busy}
                className="chip chip-accent text-[10.5px]"
              >
                <i className="ri-check-line" />
                Save policy
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="panel">
        <header className="panel-head">
          <h3 className="panel-title">Alert recipients</h3>
          <span className="label">{recipients.length}</span>
        </header>
        <div className="panel-body space-y-2.5">
          {recipients.length === 0 && (
            <div className="banner">
              <span className="flex items-start gap-2">
                <i className="ri-error-warning-line text-[13px] t-danger mt-px" />
                <span className="text-[11.5px] t-danger">
                  No recipients — DLP alerts are being generated but delivered to nobody.
                </span>
              </span>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-1.5">
            <label className="field" style={{ minWidth: 150 }}>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Name (optional)"
                className="w-full text-[11.5px]"
              />
            </label>
            <label className="field flex-1" style={{ minWidth: 200 }}>
              <i className="ri-mail-line text-[12px] t3" />
              <input
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void addRecipient(); }}
                type="email"
                placeholder="alerts@company.com"
                className="w-full text-[11.5px]"
              />
            </label>
            <button
              onClick={() => void addRecipient()}
              disabled={busy || !newEmail.trim()}
              className="chip chip-accent text-[10.5px] disabled:opacity-50"
            >
              <i className="ri-add-line" />
              Add
            </button>
          </div>

          {recipients.length > 0 && (
            <>
              <p className="text-[10.5px] t3">
                Click a severity to include or exclude it from that person's alerts.
              </p>
              <div className="space-y-1.5">
                {recipients.map((r) => (
                  <div key={r.id} className="ctl-row">
                    <div className="min-w-0">
                      <p className="text-[12px] t1 truncate">{r.full_name ?? r.email}</p>
                      {r.full_name && <p className="text-[10.5px] t3 truncate">{r.email}</p>}
                      {r.severities.length === 0 && (
                        <p className="text-[10px] t-warning mt-0.5">No severities — receives nothing</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {SEVERITIES.map((s) => {
                        const on = r.severities.includes(s);
                        return (
                          <button
                            key={s}
                            onClick={() => void toggleSeverity(r, s)}
                            className="text-[10px] px-1.5 py-0.5 rounded-md capitalize transition-colors"
                            style={{
                              color: on ? sevTone(s) : 'var(--d-t3)',
                              background: on ? 'var(--d-sunken)' : 'transparent',
                              border: `1px solid ${on ? 'var(--d-line)' : 'transparent'}`,
                            }}
                            title={on ? `Stop sending ${s}` : `Also send ${s}`}
                          >
                            {s}
                          </button>
                        );
                      })}
                      <button
                        onClick={() => void removeRecipient(r)}
                        className="icon-btn ml-1"
                        title="Remove recipient"
                      >
                        <i className="ri-delete-bin-line" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
