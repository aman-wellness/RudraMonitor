// Bottom tab bar — Camera (default) / Recent / Settings. SafeArea-aware
// via env(safe-area-inset-bottom) so it clears the iPhone home indicator.

interface Props {
  active: string;
  onNavigate: (to: string) => void;
}

const TABS: Array<{ path: string; label: string; icon: string }> = [
  { path: "/",         label: "Capture", icon: "📷" },
  { path: "/recent",   label: "Recent",  icon: "🧾" },
  { path: "/settings", label: "Account", icon: "⚙" },
];

export default function TabBar({ active, onNavigate }: Props) {
  return (
    <div style={{
      display: "flex",
      borderTop: "1px solid #1f242c",
      background: "#0f1115",
      paddingBottom: "env(safe-area-inset-bottom)",
    }}>
      {TABS.map((t) => {
        const isActive = active === t.path;
        return (
          <button
            key={t.path}
            onClick={() => onNavigate(t.path)}
            style={{
              flex: 1,
              padding: "10px 0 12px",
              background: "transparent",
              border: "none",
              color: isActive ? "#22d3a2" : "#6b7280",
              fontSize: 11,
              fontWeight: isActive ? 600 : 400,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 2,
              cursor: "pointer",
            }}
          >
            <span style={{ fontSize: 20, lineHeight: 1 }}>{t.icon}</span>
            <span>{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}
