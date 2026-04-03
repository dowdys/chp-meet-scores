"use client";

export function OrderActions({
  orderNumber,
  status,
}: {
  orderNumber: string;
  status: string;
}) {
  const statusColor =
    status === "paid" ? "bg-green-100 text-green-700 border-green-200" :
    status === "shipped" ? "bg-blue-100 text-blue-700 border-blue-200" :
    status === "processing" ? "bg-yellow-100 text-yellow-700 border-yellow-200" :
    status === "delivered" ? "bg-green-200 text-green-800 border-green-300" :
    status === "refunded" || status === "cancelled" ? "bg-red-100 text-red-700 border-red-200" :
    "bg-gray-100 text-gray-700 border-gray-200";

  return (
    <div className="mb-6">
      {/* Prominent status display */}
      <div className={`rounded-lg border p-3 mb-3 ${statusColor}`}>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide opacity-70">Order Status</p>
            <p className="text-lg font-semibold capitalize">{status}</p>
          </div>
          <span className="font-mono text-sm opacity-70">{orderNumber}</span>
        </div>
      </div>

      {/* Placeholder action buttons (wired in Units 2 & 3) */}
      <div className="flex gap-2">
        <button
          disabled
          className="px-3 py-1.5 rounded text-xs font-medium bg-gray-100 text-gray-400 border border-gray-200 cursor-not-allowed"
          title="Coming soon"
        >
          Cancel Order
        </button>
        <button
          disabled
          className="px-3 py-1.5 rounded text-xs font-medium bg-gray-100 text-gray-400 border border-gray-200 cursor-not-allowed"
          title="Coming soon"
        >
          Override Status
        </button>
        <button
          disabled
          className="px-3 py-1.5 rounded text-xs font-medium bg-gray-100 text-gray-400 border border-gray-200 cursor-not-allowed"
          title="Coming soon"
        >
          Re-batch
        </button>
      </div>
    </div>
  );
}
