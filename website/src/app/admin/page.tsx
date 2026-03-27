import { getDashboardStats } from "@/lib/admin";
import { formatPrice } from "@/lib/utils";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const stats = await getDashboardStats();

  const cards = [
    { label: "Orders This Week", value: stats.ordersThisWeek, href: "/admin/orders" },
    { label: "Revenue This Week", value: formatPrice(stats.revenueThisWeek), href: "/admin/orders" },
    { label: "Backs Pending", value: stats.pendingBacks, href: "/admin/backs" },
    { label: "At Printer", value: stats.activeBatches + " batches", href: "/admin/batches" },
    { label: "Ready to Ship", value: stats.readyToShip, href: "/admin/shipping" },
    { label: "Name Corrections", value: stats.pendingCorrections, href: "/admin/alerts", alert: stats.pendingCorrections > 0 },
    { label: "Email Signups", value: stats.pendingCaptures, href: "/admin/emails" },
    { label: "Total Orders", value: stats.totalOrders, href: "/admin/orders" },
  ];

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-6">Dashboard</h1>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {cards.map((card) => (
          <Link
            key={card.label}
            href={card.href}
            className={`rounded-xl p-4 border hover:shadow-md transition ${
              card.alert ? "border-red-300 bg-red-50" : "border-gray-200 bg-white"
            }`}
          >
            <p className="text-sm text-gray-500">{card.label}</p>
            <p className="text-2xl font-bold mt-1">{card.value}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
