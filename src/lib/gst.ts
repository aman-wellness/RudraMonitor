// India GSTIN structural helpers. A valid GSTIN is 15 chars:
//   [SS][PPPPPPPPPP][E][Z][C]
// where SS = state code (2 digits), PPPPPPPPPP = PAN (10 chars), E = entity number,
// Z = literal 'Z', C = checksum.
// We don't run the checksum here (checksum requires the GSTN MOD 36 algorithm and is
// strict — we'd rather let users save a GSTIN that *looks* valid; the API lookup is
// the authoritative validator).

export const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

export type GstStructured = {
  valid: boolean;
  stateCode: string | null;
  stateName: string | null;
  pan: string | null;
  entityCode: string | null;
};

// Source: https://services.gst.gov.in/ — official GST state code list.
const GST_STATE_CODES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab',
  '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi',
  '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram',
  '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '25': 'Daman and Diu', '26': 'Dadra and Nagar Haveli',
  '27': 'Maharashtra', '28': 'Andhra Pradesh', '29': 'Karnataka', '30': 'Goa',
  '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh',
  '38': 'Ladakh',
};

export function decodeGstin(raw: string): GstStructured {
  const g = raw.trim().toUpperCase();
  if (!GSTIN_REGEX.test(g)) {
    return { valid: false, stateCode: null, stateName: null, pan: null, entityCode: null };
  }
  return {
    valid: true,
    stateCode: g.slice(0, 2),
    stateName: GST_STATE_CODES[g.slice(0, 2)] ?? null,
    pan: g.slice(2, 12),
    entityCode: g.slice(12, 13),
  };
}
