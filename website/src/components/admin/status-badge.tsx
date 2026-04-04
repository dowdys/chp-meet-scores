/**
 * Shared StatusBadge component for consistent status display across admin pages.
 * Used in order detail panel, orders list, batches page, shipping page, etc.
 */

const ORDER_STATUS_COLORS: Record<string, string> = {
  pending: "bg-gray-100 text-gray-700 border-gray-200",
  paid: "bg-green-100 text-green-700 border-green-200",
  processing: "bg-yellow-100 text-yellow-700 border-yellow-200",
  shipped: "bg-blue-100 text-blue-700 border-blue-200",
  delivered: "bg-green-200 text-green-800 border-green-300",
  refunded: "bg-red-100 text-red-700 border-red-200",
  cancelled: "bg-red-100 text-red-700 border-red-200",
};

const ITEM_STATUS_COLORS: Record<string, string> = {
  pending: "bg-gray-100 text-gray-700 border-gray-200",
  queued: "bg-yellow-100 text-yellow-700 border-yellow-200",
  at_printer: "bg-yellow-100 text-yellow-700 border-yellow-200",
  printed: "bg-green-100 text-green-700 border-green-200",
  packed: "bg-green-200 text-green-800 border-green-300",
  cancelled: "bg-red-100 text-red-700 border-red-200",
};

const BATCH_STATUS_COLORS: Record<string, string> = {
  queued: "bg-gray-100 text-gray-700 border-gray-200",
  at_printer: "bg-yellow-100 text-yellow-700 border-yellow-200",
  returned: "bg-green-100 text-green-700 border-green-200",
};

function getColorClasses(status: string, type?: "order" | "item" | "batch"): string {
  if (type === "item") return ITEM_STATUS_COLORS[status] || "bg-gray-100 text-gray-700 border-gray-200";
  if (type === "batch") return BATCH_STATUS_COLORS[status] || "bg-gray-100 text-gray-700 border-gray-200";
  // For "order" type or default, check order statuses first, then item statuses as fallback
  return ORDER_STATUS_COLORS[status] || ITEM_STATUS_COLORS[status] || "bg-gray-100 text-gray-700 border-gray-200";
}

export function StatusBadge({
  status,
  type,
}: {
  status: string;
  type?: "order" | "item" | "batch";
}) {
  const colorClasses = getColorClasses(status, type);
  const displayStatus = status.replace(/_/g, " ");

  return (
    <span className={`inline-block px-2 py-0.5 rounded border text-xs font-medium ${colorClasses}`}>
      {displayStatus}
    </span>
  );
}
