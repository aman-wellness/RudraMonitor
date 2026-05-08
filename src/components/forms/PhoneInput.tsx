import { useMemo } from 'react';
import { Country } from 'country-state-city';

interface Props {
  value: string;            // Combined "+91 9876543210"; empty string is fine.
  onChange: (next: string) => void;
  className?: string;
  /** ISO2 of the country whose phone code should be the default if `value` has none. */
  defaultCountry?: string;
}

const DEFAULT_INPUT =
  'flex-1 bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-cyan-500';

// Pull a single source of truth for "+code", flag and country name out of the
// offline country-state-city dataset, deduped by phone code so the dropdown
// stays compact (e.g. +1 covers US/CA but we list it once).
function buildCodes() {
  const seen = new Map<string, { code: string; iso: string; name: string; flag: string }>();
  for (const c of Country.getAllCountries()) {
    const code = (c.phonecode ?? '').replace(/^\+/, '').trim();
    if (!code || /[^0-9]/.test(code)) continue; // skip composite codes like "1-684"
    const key = `+${code}`;
    if (!seen.has(key)) seen.set(key, { code: key, iso: c.isoCode, name: c.name, flag: c.flag ?? '' });
  }
  return [...seen.values()].sort((a, b) => parseInt(a.code.slice(1)) - parseInt(b.code.slice(1)));
}

function parse(value: string, defaultCode: string): { code: string; number: string } {
  const trimmed = (value ?? '').trim();
  const m = trimmed.match(/^(\+\d{1,4})\s*(.*)$/);
  if (m) return { code: m[1], number: m[2].replace(/\D/g, '').slice(0, 10) };
  return { code: defaultCode, number: trimmed.replace(/\D/g, '').slice(0, 10) };
}

export default function PhoneInput({ value, onChange, className, defaultCountry = 'IN' }: Props) {
  const codes = useMemo(buildCodes, []);
  const defaultCode = useMemo(() => {
    const c = Country.getCountryByCode(defaultCountry);
    return c?.phonecode ? `+${c.phonecode.replace(/^\+/, '')}` : '+91';
  }, [defaultCountry]);

  const { code, number } = parse(value, defaultCode);

  const emit = (nextCode: string, nextNumber: string) => {
    const cleaned = nextNumber.replace(/\D/g, '').slice(0, 10);
    onChange(cleaned ? `${nextCode} ${cleaned}` : '');
  };

  return (
    <div className="flex gap-2">
      <select
        value={code}
        onChange={(e) => emit(e.target.value, number)}
        className="bg-dark-900 border border-dark-700 rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-cyan-500 w-28"
      >
        {codes.map((c) => (
          <option key={`${c.iso}-${c.code}`} value={c.code}>
            {c.flag} {c.code}
          </option>
        ))}
      </select>
      <input
        type="tel"
        inputMode="numeric"
        pattern="[0-9]{10}"
        maxLength={10}
        value={number}
        onChange={(e) => emit(code, e.target.value)}
        placeholder="10-digit number"
        className={className ?? DEFAULT_INPUT}
      />
    </div>
  );
}
