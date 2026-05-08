import { useState } from 'react';

interface DataPoint {
  time: string;
  events: number;
  active: number;
  idle: number;
}

interface Props {
  data: DataPoint[];
}

const HEIGHT = 192;     // px — matches the previous h-48 visual
const PAD_TOP = 8;
const PAD_BOTTOM = 24;  // for x-axis labels
const PAD_LEFT = 36;    // for y-axis labels
const PAD_RIGHT = 8;

export default function TimelineChart({ data }: Props) {
  const [hover, setHover] = useState<number | null>(null);

  const maxVal = Math.max(...data.map((d) => Math.max(d.events, d.active, d.idle)), 1);

  // Y-axis ticks
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((p) => Math.round(maxVal * p));

  return (
    <div className="bg-dark-800 border border-dark-700 rounded-xl p-4 md:p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="w-4 h-4 flex items-center justify-center text-violet-400">
            <i className="ri-pulse-line" />
          </span>
          <h3 className="text-sm font-poppins font-semibold text-white">Activity Timeline</h3>
        </div>
        <div className="flex items-center gap-3 text-[10px] text-gray-400">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-violet-500" /> Events</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-emerald-500" /> Active (min)</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-amber-500" /> Idle (min)</span>
        </div>
      </div>

      {data.length === 0 ? (
        <div className="h-48 flex items-center justify-center text-xs text-gray-500">
          No activity recorded in this window.
        </div>
      ) : (
        <div className="relative">
          <svg
            viewBox={`0 0 1000 ${HEIGHT}`}
            preserveAspectRatio="none"
            className="w-full"
            style={{ height: HEIGHT }}
          >
            {/* Grid + Y-axis labels */}
            {ticks.map((t, i) => {
              const y = HEIGHT - PAD_BOTTOM - ((HEIGHT - PAD_TOP - PAD_BOTTOM) * i) / 4;
              return (
                <g key={i}>
                  <line
                    x1={PAD_LEFT} x2={1000 - PAD_RIGHT} y1={y} y2={y}
                    stroke="rgba(255,255,255,0.05)" strokeWidth={1}
                  />
                  <text
                    x={PAD_LEFT - 6} y={y + 3}
                    textAnchor="end" fontSize={10} fill="#6b7280"
                  >
                    {t}
                  </text>
                </g>
              );
            })}

            {/* Bars — three columns per slot (events, active, idle) */}
            {data.map((d, i) => {
              const slotWidth = (1000 - PAD_LEFT - PAD_RIGHT) / data.length;
              const slotX = PAD_LEFT + i * slotWidth;
              const innerW = slotWidth * 0.78;
              const innerX = slotX + (slotWidth - innerW) / 2;
              const barW = innerW / 3 - 1;
              const chartH = HEIGHT - PAD_TOP - PAD_BOTTOM;

              const heights = [
                { v: d.events, color: '#8b5cf6' },
                { v: d.active, color: '#10b981' },
                { v: d.idle,   color: '#f59e0b' },
              ];

              return (
                <g
                  key={i}
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover((h) => (h === i ? null : h))}
                >
                  {/* invisible hit area for hover */}
                  <rect x={slotX} y={PAD_TOP} width={slotWidth} height={chartH} fill="transparent" />
                  {heights.map((h, j) => {
                    const barH = (h.v / maxVal) * chartH;
                    const x = innerX + j * (barW + 1);
                    return (
                      <rect
                        key={j}
                        x={x}
                        y={HEIGHT - PAD_BOTTOM - barH}
                        width={barW}
                        height={barH}
                        fill={h.color}
                        opacity={hover === null || hover === i ? 0.85 : 0.35}
                        rx={1}
                      />
                    );
                  })}
                </g>
              );
            })}

            {/* X-axis labels — show every Nth so they don't overlap */}
            {data.map((d, i) => {
              const skip = Math.max(1, Math.ceil(data.length / 8));
              if (i % skip !== 0 && i !== data.length - 1) return null;
              const slotWidth = (1000 - PAD_LEFT - PAD_RIGHT) / data.length;
              const x = PAD_LEFT + i * slotWidth + slotWidth / 2;
              return (
                <text key={i} x={x} y={HEIGHT - 6} textAnchor="middle" fontSize={10} fill="#6b7280">
                  {d.time}
                </text>
              );
            })}
          </svg>

          {/* Tooltip */}
          {hover !== null && data[hover] && (
            <div
              className="absolute pointer-events-none bg-dark-900 border border-dark-700 rounded-lg px-2.5 py-1.5 text-[10px] text-white whitespace-nowrap shadow-lg"
              style={{
                left: `${PAD_LEFT / 10 + (hover + 0.5) * (100 - (PAD_LEFT + PAD_RIGHT) / 10) / data.length}%`,
                top: 4,
                transform: 'translateX(-50%)',
              }}
            >
              <p className="font-medium mb-0.5">{data[hover].time}</p>
              <p><span className="text-violet-400">●</span> Events: {data[hover].events}</p>
              <p><span className="text-emerald-400">●</span> Active: {data[hover].active}m</p>
              <p><span className="text-amber-400">●</span> Idle: {data[hover].idle}m</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
