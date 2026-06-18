import { useEffect, useMemo, useState } from 'react';

interface Props {
  value: string;            // Combined "+91 9876543210"; empty string is fine.
  onChange: (next: string) => void;
  className?: string;
  /** ISO2 of the country whose phone code should be the default if `value` has none. */
  defaultCountry?: string;
}

// `min-w-0` on the input is critical — without it browsers give <input> a
// default intrinsic min-width that breaks `flex-1` and pushes the input out of
// its parent column on narrow modal layouts.
const DEFAULT_INPUT =
  'flex-1 min-w-0 bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-cyan-500';

type CountryItem = { code: string; iso: string; name: string; flag: string };

// Inline fallback covering 99% of real-world phone numbers. The full
// dataset (with every IANA country + composite codes) lives in
// `country-state-city` and is fetched lazily via dynamic import below.
// Without this fallback the initial render would block on an 8 MB chunk.
const FALLBACK_CODES: CountryItem[] = [
  { code: '+1',   iso: 'US', name: 'United States',  flag: '🇺🇸' },
  { code: '+7',   iso: 'RU', name: 'Russia',         flag: '🇷🇺' },
  { code: '+20',  iso: 'EG', name: 'Egypt',          flag: '🇪🇬' },
  { code: '+27',  iso: 'ZA', name: 'South Africa',   flag: '🇿🇦' },
  { code: '+31',  iso: 'NL', name: 'Netherlands',    flag: '🇳🇱' },
  { code: '+33',  iso: 'FR', name: 'France',         flag: '🇫🇷' },
  { code: '+34',  iso: 'ES', name: 'Spain',          flag: '🇪🇸' },
  { code: '+39',  iso: 'IT', name: 'Italy',          flag: '🇮🇹' },
  { code: '+44',  iso: 'GB', name: 'United Kingdom', flag: '🇬🇧' },
  { code: '+49',  iso: 'DE', name: 'Germany',        flag: '🇩🇪' },
  { code: '+52',  iso: 'MX', name: 'Mexico',         flag: '🇲🇽' },
  { code: '+55',  iso: 'BR', name: 'Brazil',         flag: '🇧🇷' },
  { code: '+60',  iso: 'MY', name: 'Malaysia',       flag: '🇲🇾' },
  { code: '+61',  iso: 'AU', name: 'Australia',      flag: '🇦🇺' },
  { code: '+62',  iso: 'ID', name: 'Indonesia',      flag: '🇮🇩' },
  { code: '+63',  iso: 'PH', name: 'Philippines',    flag: '🇵🇭' },
  { code: '+65',  iso: 'SG', name: 'Singapore',      flag: '🇸🇬' },
  { code: '+66',  iso: 'TH', name: 'Thailand',       flag: '🇹🇭' },
  { code: '+81',  iso: 'JP', name: 'Japan',          flag: '🇯🇵' },
  { code: '+82',  iso: 'KR', name: 'South Korea',    flag: '🇰🇷' },
  { code: '+84',  iso: 'VN', name: 'Vietnam',        flag: '🇻🇳' },
  { code: '+86',  iso: 'CN', name: 'China',          flag: '🇨🇳' },
  { code: '+90',  iso: 'TR', name: 'Turkey',         flag: '🇹🇷' },
  { code: '+91',  iso: 'IN', name: 'India',          flag: '🇮🇳' },
  { code: '+92',  iso: 'PK', name: 'Pakistan',       flag: '🇵🇰' },
  { code: '+93',  iso: 'AF', name: 'Afghanistan',    flag: '🇦🇫' },
  { code: '+94',  iso: 'LK', name: 'Sri Lanka',      flag: '🇱🇰' },
  { code: '+95',  iso: 'MM', name: 'Myanmar',        flag: '🇲🇲' },
  { code: '+98',  iso: 'IR', name: 'Iran',           flag: '🇮🇷' },
  { code: '+212', iso: 'MA', name: 'Morocco',        flag: '🇲🇦' },
  { code: '+213', iso: 'DZ', name: 'Algeria',        flag: '🇩🇿' },
  { code: '+234', iso: 'NG', name: 'Nigeria',        flag: '🇳🇬' },
  { code: '+254', iso: 'KE', name: 'Kenya',          flag: '🇰🇪' },
  { code: '+255', iso: 'TZ', name: 'Tanzania',       flag: '🇹🇿' },
  { code: '+256', iso: 'UG', name: 'Uganda',         flag: '🇺🇬' },
  { code: '+880', iso: 'BD', name: 'Bangladesh',     flag: '🇧🇩' },
  { code: '+886', iso: 'TW', name: 'Taiwan',         flag: '🇹🇼' },
  { code: '+966', iso: 'SA', name: 'Saudi Arabia',   flag: '🇸🇦' },
  { code: '+971', iso: 'AE', name: 'UAE',            flag: '🇦🇪' },
  { code: '+972', iso: 'IL', name: 'Israel',         flag: '🇮🇱' },
  { code: '+974', iso: 'QA', name: 'Qatar',          flag: '🇶🇦' },
  { code: '+977', iso: 'NP', name: 'Nepal',          flag: '🇳🇵' },
];

function parse(value: string, defaultCode: string): { code: string; number: string } {
  const trimmed = (value ?? '').trim();
  const m = trimmed.match(/^(\+\d{1,4})\s*(.*)$/);
  if (m) return { code: m[1], number: m[2].replace(/\D/g, '').slice(0, 10) };
  return { code: defaultCode, number: trimmed.replace(/\D/g, '').slice(0, 10) };
}

export default function PhoneInput({ value, onChange, className, defaultCountry = 'IN' }: Props) {
  // Start with the 42-country fallback (renders instantly). Then
  // asynchronously upgrade to the full `country-state-city` dataset
  // (~250 countries) on the next event-loop tick. The upgrade is a
  // dynamic import → Vite emits this as a separate chunk that's only
  // fetched when PhoneInput actually mounts, not on app startup.
  // Net effect: the 8 MB country dataset stops blocking initial paint
  // by ~3-5 seconds on slow connections.
  const [codes, setCodes] = useState<CountryItem[]>(FALLBACK_CODES);

  useEffect(() => {
    let cancelled = false;
    void import('country-state-city').then((mod) => {
      if (cancelled) return;
      const seen = new Map<string, CountryItem>();
      for (const c of mod.Country.getAllCountries()) {
        const code = (c.phonecode ?? '').replace(/^\+/, '').trim();
        if (!code || /[^0-9]/.test(code)) continue;
        const key = `+${code}`;
        if (!seen.has(key)) {
          seen.set(key, { code: key, iso: c.isoCode, name: c.name, flag: c.flag ?? '' });
        }
      }
      const full = [...seen.values()].sort(
        (a, b) => parseInt(a.code.slice(1)) - parseInt(b.code.slice(1)),
      );
      setCodes(full);
    });
    return () => { cancelled = true; };
  }, []);

  const defaultCode = useMemo(() => {
    const c = codes.find((c) => c.iso === defaultCountry);
    return c?.code ?? '+91';
  }, [codes, defaultCountry]);

  const { code, number } = parse(value, defaultCode);

  const emit = (nextCode: string, nextNumber: string) => {
    const cleaned = nextNumber.replace(/\D/g, '').slice(0, 10);
    onChange(cleaned ? `${nextCode} ${cleaned}` : '');
  };

  return (
    <div className="flex gap-2 w-full min-w-0">
      <select
        value={code}
        onChange={(e) => emit(e.target.value, number)}
        className="shrink-0 bg-dark-900 border border-dark-700 rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-cyan-500 w-24"
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
