import { useMemo } from 'react';
import { Country, State, City } from 'country-state-city';

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

  const countries = useMemo(() => Country.getAllCountries(), []);
  const states = useMemo(() => (country ? State.getStatesOfCountry(country) : []), [country]);
  const cities = useMemo(() => {
    if (!country || !state) return [];
    // The dataset's State entries expose `isoCode`; resolve from name if user typed it.
    const stateRow = states.find((s) => s.name === state || s.isoCode === state);
    return stateRow ? City.getCitiesOfState(country, stateRow.isoCode) : [];
  }, [country, state, states]);

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
