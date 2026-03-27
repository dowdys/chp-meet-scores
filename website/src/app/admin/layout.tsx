import Link from "next/link";

const NAV_ITEMS = [
  { href: "/admin", label: "Dashboard" },
  { href: "/admin/orders", label: "Orders" },
  { href: "/admin/backs", label: "By Back" },
  { href: "/admin/batches", label: "Batches" },
  { href: "/admin/shipping", label: "Shipping" },
  { href: "/admin/alerts", label: "Alerts" },
  { href: "/admin/emails", label: "Emails" },
  { href: "/admin/meets", label: "Meets" },
  { href: "/admin/analytics", label: "Analytics" },
  { href: "/admin/settings", label: "Settings" },
];

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen">
      <nav className="w-56 bg-gray-900 text-white p-4 space-y-1">
        <h2 className="text-lg font-bold mb-4 px-3">CHP Admin</h2>
        {NAV_ITEMS.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="block px-3 py-2 rounded hover:bg-gray-800 text-sm"
          >
            {item.label}
          </Link>
        ))}
      </nav>
      <main className="flex-1 bg-gray-50">{children}</main>
    </div>
  );
}
