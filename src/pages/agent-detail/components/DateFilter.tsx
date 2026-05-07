import { useState } from 'react';

const presets = ['Today', 'Yesterday', '7 days', '30 days', 'All time'] as const;

interface Props {
  onChange: (range: string) => void;
}

export default function DateFilter({ onChange }: Props) {
  const [active, setActive] = useState('Today');

  const handleClick = (p: string) => {
    setActive(p);
    onChange(p);
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-1 bg-dark-900 rounded-lg p-1 overflow-x-auto">
        {presets.map((p) => (
          <button
            key={p}
            onClick={() => handleClick(p)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-all ${
              active === p ? 'bg-dark-700 text-white shadow-sm' : 'text-gray-500 hover:text-gray-400'
            }`}
          >
            {p}
          </button>
        ))}
      </div>

      <div className="flex items-center bg-dark-800 border border-dark-700 rounded-lg px-3 py-1.5 gap-2 text-xs text-gray-500">
        <span className="w-3 h-3 flex items-center justify-center"><i className="ri-calendar-line" /></span>
        <span>May 07, 00:00</span>
        <span className="text-gray-600">→</span>
        <span>May 07, 10:05</span>
      </div>
    </div>
  );
}