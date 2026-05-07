import { useNavigate } from 'react-router-dom';
import { useState } from 'react';

interface Props {
  name: string;
  machine: string;
  status: string;
  version: string;
  ipAddress: string;
  department?: string;
}

const deptOptions = ['Development', 'HR', 'Finance', 'Design', 'Sales', 'Support', 'Marketing'];

export default function AgentHeader({ name, machine, status, version, ipAddress, department = 'Development' }: Props) {
  const navigate = useNavigate();
  const [dept, setDept] = useState(department);
  const [editing, setEditing] = useState(false);

  const getInitial = (n: string) => n.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();

  const statusColor =
    status === 'online'
      ? 'bg-emerald-500/20 text-emerald-400'
      : status === 'idle'
        ? 'bg-amber-500/20 text-amber-400'
        : 'bg-red-500/20 text-red-400';

  const deptColor = (d: string) => {
    const map: Record<string, string> = {
      Development: 'bg-blue-500/15 text-blue-400 border border-blue-500/25',
      HR: 'bg-pink-500/15 text-pink-400 border border-pink-500/25',
      Finance: 'bg-amber-500/15 text-amber-400 border border-amber-500/25',
      Design: 'bg-violet-500/15 text-violet-400 border border-violet-500/25',
      Sales: 'bg-teal-500/15 text-teal-400 border border-teal-500/25',
      Support: 'bg-cyan-500/15 text-cyan-400 border border-cyan-500/25',
      Marketing: 'bg-orange-500/15 text-orange-400 border border-orange-500/25',
    };
    return map[d] || 'bg-gray-500/15 text-gray-400 border border-gray-500/25';
  };

  return (
    <div className="bg-dark-800 border border-dark-700 rounded-xl p-4 md:p-5">
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-xl bg-violet-500/20 flex items-center justify-center flex-shrink-0">
            <span className="text-xl font-bold text-violet-400">{getInitial(name)}</span>
          </div>
          <div>
            <div className="flex items-center gap-3 mb-1">
              <h2 className="text-lg font-poppins font-bold text-white">{name}</h2>
              <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide ${statusColor}`}>
                {status === 'online' ? 'Active Now' : status === 'idle' ? 'Idle' : 'Offline'}
              </span>
              <div className="relative">
                <button
                  onClick={() => setEditing(!editing)}
                  className={`px-2 py-0.5 rounded-md text-[10px] font-medium ${deptColor(dept)} flex items-center gap-1 cursor-pointer hover:opacity-80`}
                >
                  {dept}
                  <span className="w-3 h-3 flex items-center justify-center"><i className="ri-arrow-down-s-line" /></span>
                </button>
                {editing && (
                  <div className="absolute top-full left-0 mt-1 bg-dark-800 border border-dark-700 rounded-lg shadow-xl py-1 min-w-[140px] z-30 overflow-hidden">
                    {deptOptions.map((d) => (
                      <button
                        key={d}
                        onClick={() => { setDept(d); setEditing(false); }}
                        className={`w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center gap-2 ${
                          d === dept ? 'text-emerald-400 bg-emerald-500/10' : 'text-gray-300 hover:bg-dark-700'
                        }`}
                      >
                        {d === dept && <span className="w-3 h-3 flex items-center justify-center"><i className="ri-check-line text-[10px]" /></span>}
                        {d}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center gap-3 text-xs text-gray-500 flex-wrap">
              <span className="flex items-center gap-1">
                <span className="w-3 h-3 flex items-center justify-center"><i className="ri-computer-line" /></span>
                {machine}
              </span>
              <span className="flex items-center gap-1">
                <span className="w-3 h-3 flex items-center justify-center"><i className="ri-code-s-slash-line" /></span>
                {version}
              </span>
              <span className="flex items-center gap-1">
                <span className="w-3 h-3 flex items-center justify-center"><i className="ri-wifi-line" /></span>
                {ipAddress}
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => navigate('/dashboard')}
            className="px-3 py-1.5 rounded-lg border border-dark-600 text-gray-300 text-xs font-medium hover:bg-dark-700 transition-colors flex items-center gap-1.5"
          >
            <span className="w-3 h-3 flex items-center justify-center"><i className="ri-arrow-left-line" /></span>
            All Agents
          </button>
          <button className="px-3 py-1.5 rounded-lg border border-red-500/30 text-red-400 text-xs font-medium hover:bg-red-500/10 transition-colors flex items-center gap-1.5">
            <span className="w-3 h-3 flex items-center justify-center"><i className="ri-delete-bin-line" /></span>
            Remove
          </button>
        </div>
      </div>
    </div>
  );
}