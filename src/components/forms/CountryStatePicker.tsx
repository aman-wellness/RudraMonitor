import { useEffect, useMemo, useState } from 'react';
// `country-state-city` is ~8 MB once unpacked (states + cities for every
// country). We do NOT import it at the top — that would block the whole
// app's initial paint even though this picker is only mounted on a
// handful of admin/onboarding forms. Instead the data loads on demand
// inside useEffect, gated behind an isolated chunk Vite splits off.
type CountryRow = { isoCode: string; name: string; flag: string };
type StateRow = { isoCode: string; name: string };
type CityRow = { name: string; latitude?: string };
type CscModule = {
  Country: { getAllCountries: () => CountryRow[] };
  State: { getStatesOfCountry: (iso: string) => StateRow[] };
  City: { getCitiesOfState: (countryIso: string, stateIso: string) => CityRow[] };
};

interface Props {
  country: string;          // ISO2 country code (e.g. "IN")
  state: string;            // free-form state name (also accepts ISO state code)
  city: string;             // free-form city name
  onChange: (next: { country: string; state: string; city: string }) => void;
  inputClassName?: string;
  /** Lock the country (used after GST autofill where country must be India). */
  countryLocked?: boolean;
}

const DEFAULT_INPUT =
  'w-full bg-dark-900 border border-dark-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-cyan-500';

/**
 * 3-step picker driven by the offline `country-state-city` dataset:
 *   country → state → city
 *
 * `state` and `city` are stored/emitted as plain names so the rest of the app
 * (org row, invoice address, etc.) can keep them as text without joining lookup
 * tables. The country is stored as an ISO2 code — short, stable, and easy to map
 * back to a name on render.
 */
export default function CountryStatePicker({ country, state, city, onChange, inputClassName, countryLocked }: Props) {
  const inputCls = inputClassName ?? DEFAULT_INPUT;

  // The full dataset loads asynchronously after first render; until then
  // the dropdowns show "Loading…". This trades a 200 ms placeholder
  // for ~3-5 sec faster initial paint on the app shell.
  const [csc, setCsc] = useState<CscModule | null>(null);
  useEffect(() => {
    let cancelled = false;
    void import('country-state-city').then((mod) => {
      if (!cancelled) setCsc(mod as unknown as CscModule);
    });
    return () => { cancelled = true; };
  }, []);

  const countries = useMemo(() => csc?.Country.getAllCountries() ?? [], [csc]);
  const states = useMemo(
    () => (csc && country ? csc.State.getStatesOfCountry(country) : []),
    [csc, country],
  );
  const cities = useMemo(() => {
    if (!csc || !country || !state) return [];
    // The dataset's State entries expose `isoCode`; resolve from name if user typed it.
    const stateRow = states.find((s) => s.name === state || s.isoCode === state);
    return stateRow ? csc.City.getCitiesOfState(country, stateRow.isoCode) : [];
  }, [csc, country, state, states]);

  return (
    <div className="grid grid-cols-3 gap-3">
      <div>
        <label className="text-[11px] text-gray-500 uppercase tracking-wider block">Country</label>
        <select
          value={country}
          disabled={countryLocked}
          onChange={(e) => onChange({ country: e.target.value, state: '', city: '' })}
          className={`mt-1 ${inputCls} disabled:opacity-60`}
        >
          <option value="">Select…</option>
          {countries.map((c) => (
            <option key={c.isoCode} value={c.isoCode}>{c.flag} {c.name}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="text-[11px] text-gray-500 uppercase tracking-wider block">State</label>
        <select
          value={state}
          disabled={!country}
          onChange={(e) => onChange({ country, state: e.target.value, city: '' })}
          className={`mt-1 ${inputCls} disabled:opacity-60`}
        >
          <option value="">{country ? 'Select…' : 'Pick country first'}</option>
          {states.map((s) => (
            <option key={s.isoCode} value={s.name}>{s.name}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="text-[11px] text-gray-500 uppercase tracking-wider block">City</label>
        {cities.length > 0 ? (
          <select
            value={city}
            disabled={!state}
            onChange={(e) => onChange({ country, state, city: e.target.value })}
            className={`mt-1 ${inputCls} disabled:opacity-60`}
          >
            <option value="">{state ? 'Select…' : 'Pick state first'}</option>
            {cities.map((c) => <option key={`${c.name}-${c.latitude}`} value={c.name}>{c.name}</option>)}
          </select>
        ) : (
          // Fallback for countries/states with no cities in the dataset — let users type freely.
          <input
            value={city}
            placeholder={state ? 'Enter city' : 'Pick state first'}
            disabled={!state}
            onChange={(e) => onChange({ country, state, city: e.target.value })}
            className={`mt-1 ${inputCls} disabled:opacity-60`}
          />
        )}
      </div>
    </div>
  );
}
