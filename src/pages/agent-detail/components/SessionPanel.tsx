import { MicroLabel, Panel } from '@/pages/dashboard/components/ui';

/* When this machine was in use — the session facts, grouped.

   These were four full-width stat cards (First login / Last activity / Logins /
   Logouts) competing with the six real metrics beside them. They belong
   together: they answer one question, "when was this person at the machine",
   and none of them is a headline number. */

type Props = {
  firstLogin: string;
  lastActivity: string;
  stillActive: boolean;
  logins: number;
  logouts: number;
  /** Days with activity in the window — the System On note depends on it. */
  daysCovered: number;
  index?: number;
};

/** `formatDateTime` gives "19 Aug 2026, 05:37 AM" — the time is the useful half
 *  here, with the date as context. */
const splitStamp = (s: string) => {
  const parts = s.split(',');
  if (parts.length < 2) return { time: s, date: null as string | null };
  return { time: parts.slice(1).join(',').trim(), date: parts[0].trim() };
};

export default function SessionPanel({
  firstLogin,
  lastActivity,
  stillActive,
  logins,
  logouts,
  daysCovered,
  index = 0,
}: Props) {
  const first = splitStamp(firstLogin);
  const last = splitStamp(lastActivity);

  return (
    <Panel title="Session" index={index}>
      <div className="grid grid-cols-2 gap-x-3 gap-y-3">
        <div className="min-w-0">
          <MicroLabel>First activity</MicroLabel>
          <p className="num num-md mt-1">{first.time}</p>
          {first.date && <p className="text-[10px] t3 mt-0.5">{first.date}</p>}
        </div>
        <div className="min-w-0">
          <MicroLabel>Last activity</MicroLabel>
          <p className="num num-md mt-1">{last.time}</p>
          <p className={`text-[10px] mt-0.5 ${stillActive ? 't-success' : 't3'}`}>
            {stillActive ? 'still active' : last.date ?? 'offline'}
          </p>
        </div>
        <div className="min-w-0">
          <MicroLabel>Sign-ins</MicroLabel>
          <p className="num num-md mt-1">{logins}</p>
          <p className="text-[10px] t3 mt-0.5">agent launches</p>
        </div>
        <div className="min-w-0">
          <MicroLabel>Sessions ended</MicroLabel>
          <p className="num num-md mt-1">{logouts}</p>
          <p className="text-[10px] t3 mt-0.5">
            {stillActive && logins > 0 ? '1 still open' : 'derived from launches'}
          </p>
        </div>
      </div>

      {/* Zero sign-ins is the normal case for an agent that was already running
          when the window opened — say so rather than letting it read as broken. */}
      {logins === 0 && (
        <p className="text-[10px] t3 leading-relaxed mt-auto pt-3 hair-t">
          <i className="ri-information-line mr-1" />
          No sign-in recorded in this window — the agent emits one only on launch, so it was
          probably already running. System-on above is derived from the first-to-last activity span
          {daysCovered > 1 ? ' of each day in the range' : ''}.
        </p>
      )}
    </Panel>
  );
}
