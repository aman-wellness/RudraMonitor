import { Link } from 'react-router-dom';

// A single breadcrumb crumb. `to` makes it a link; omit it (or it's the
// last crumb) to render as plain current-page text.
export type Crumb = { label: string; icon?: string; to?: string };

/**
 * Shared breadcrumb trail. Crumbs with a `to` render as links (hover
 * highlight); the last crumb always renders as the plain current-page
 * label regardless of `to`. Used across the dashboard pages so trail
 * items like "Dashboard" and "Agents" are consistently clickable.
 */
export default function Breadcrumb({ items }: { items: Crumb[] }) {
  return (
    <div className="flex items-center gap-2 text-xs text-gray-500">
      {items.map((c, i) => {
        const isLast = i === items.length - 1;
        const iconEl = c.icon ? (
          <span className="w-3 h-3 flex items-center justify-center"><i className={c.icon} /></span>
        ) : null;
        return (
          <div key={`${c.label}-${i}`} className="flex items-center gap-2">
            {c.to && !isLast ? (
              <Link to={c.to} className="flex items-center gap-1 hover:text-gray-200 transition-colors">
                {iconEl}{c.label}
              </Link>
            ) : isLast ? (
              <span className="flex items-center gap-1 text-white font-medium">{iconEl}{c.label}</span>
            ) : (
              <span className="flex items-center gap-1">{iconEl}{c.label}</span>
            )}
            {!isLast && <i className="ri-arrow-right-s-line text-gray-600" />}
          </div>
        );
      })}
    </div>
  );
}
