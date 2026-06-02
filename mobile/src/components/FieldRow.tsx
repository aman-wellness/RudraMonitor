// One labelled input row for the Preview screen's extracted-fields form.
// Keeps the form compact + consistent.

import type { CSSProperties } from "react";

interface Props {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: "text" | "number" | "date";
  style?: CSSProperties;
}

export default function FieldRow({ label, value, onChange, placeholder, type = "text", style }: Props) {
  return (
    <label style={{ display: "block", ...style }}>
      <div style={{
        fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em",
        color: "#6b7280", marginBottom: 4,
      }}>{label}</div>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: "100%",
          padding: "10px 12px",
          background: "#1a1f27",
          border: "1px solid #2a313c",
          borderRadius: 8,
          color: "#fff",
          fontSize: 14,
          outline: "none",
        }}
      />
    </label>
  );
}
