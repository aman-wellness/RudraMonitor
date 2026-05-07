interface DataPoint {
  time: string;
  events: number;
  active: number;
  idle: number;
}

interface Props {
  data: DataPoint[];
}

export default function TimelineChart({ data }: Props) {
  const maxVal = Math.max(...data.map((d) => Math.max(d.events, d.active, d.idle)), 1);

  return (
    <div className="bg-dark-800 border border-dark-700 rounded-xl p-4 md:p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="w-4 h-4 flex items-center justify-center text-violet-400">
            <i className="ri-pulse-line" />
          </span>
          <h3 className="text-sm font-poppins font-semibold text-white">Activity Timeline</h3>
        </div>
        <div className="flex items-center gap-3 text-[10px] text-gray-500">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-violet-500" /> Events</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-emerald-500" /> Active (min)</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-amber-500" /> Idle (min)</span>
        </div>
      </div>

      <div className="relative h-48 md:h-56">
        {/* Y-axis */}
        <div className="absolute left-0 top-0 bottom-6 w-8 flex flex-col justify-between text-[10px] text-gray-600 text-right pr-1">
          <span>{maxVal}</span>
          <span>{Math.round(maxVal * 0.75)}</span>
          <span>{Math.round(maxVal * 0.5)}</span>
          <span>{Math.round(maxVal * 0.25)}</span>
          <span>0</span>
        </div>

        {/* Chart area */}
        <div className="absolute left-8 right-0 top-0 bottom-6 flex items-end gap-1">
          {data.map((d, i) => {
            const hEvents = (d.events / maxVal) * 100;
            const hActive = (d.active / maxVal) * 100;
            const hIdle = (d.idle / maxVal) * 100;
            return (
              <div key={i} className="flex-1 flex flex-col items-center gap-0.5 group relative">
                <div className="w-full flex flex-col-reverse gap-[1px] h-full justify-end">
                  {/* Idle */}
                  <div
                    className="w-full bg-amber-500/40 rounded-t-sm transition-all hover:bg-amber-500/60"
                    style={{ height: `${hIdle}%` }}
                  />
                  {/* Active */}
                  <div
                    className="w-full bg-emerald-500/40 rounded-t-sm transition-all hover:bg-emerald-500/60"
                    style={{ height: `${hActive}%` }}
                  />
                  {/* Events */}
                  <div
                    className="w-full bg-violet-500/40 rounded-t-sm transition-all hover:bg-violet-500/60"
                    style={{ height: `${hEvents}%` }}
                  />
                </div>

                {/* Tooltip */}
                <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-dark-900 border border-dark-700 rounded-lg px-2 py-1.5 text-[10px] text-white whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity z-10 pointer-events-none">
                  <p className="font-medium mb-0.5">{d.time}</p>
                  <p className="text-violet-400">Events: {d.events}</p>
                  <p className="text-emerald-400">Active: {d.active}m</p>
                  <p className="text-amber-400">Idle: {d.idle}m</p>
                </div>
              </div>
            );
          })}
        </div>

        {/* X-axis */}
        <div className="absolute left-8 right-0 bottom-0 flex items-end gap-1">
          {data.map((d, i) => (
            <div key={i} className="flex-1 text-center">
              <span className="text-[10px] text-gray-600">{d.time}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}