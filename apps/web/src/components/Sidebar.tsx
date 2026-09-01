"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface NavItem {
  href: string;
  label: string;
  /** Also mark active for nested detail routes under this section. */
  match?: (pathname: string) => boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const GROUPS: NavGroup[] = [
  {
    label: "Discover",
    items: [
      { href: "/", label: "Search / Ask", match: (p) => p === "/" },
      { href: "/opportunities", label: "Opportunities", match: (p) => p.startsWith("/opportunities") },
    ],
  },
  {
    label: "Act",
    items: [
      { href: "/approvals", label: "Approvals", match: (p) => p.startsWith("/approvals") },
      { href: "/payments", label: "Payments", match: (p) => p.startsWith("/payments") || p.startsWith("/transactions") },
    ],
  },
  {
    label: "Manage",
    items: [
      { href: "/archive", label: "Archive", match: (p) => p.startsWith("/archive") || p.startsWith("/missions") },
      { href: "/settings", label: "Settings", match: (p) => p.startsWith("/settings") },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname() ?? "/";
  return (
    <nav className="oos-sidebar" aria-label="Primary">
      <div className="oos-brand">
        <span className="oos-brand-mark" aria-hidden />
        Opportunity OS
      </div>
      {GROUPS.map((group) => (
        <div key={group.label}>
          <div className="oos-nav-group-label">{group.label}</div>
          {group.items.map((item) => {
            const active = item.match ? item.match(pathname) : pathname === item.href;
            return (
              <Link key={item.href} href={item.href} className="oos-nav-link" aria-current={active ? "page" : undefined}>
                <span className="oos-nav-dot" aria-hidden />
                {item.label}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
