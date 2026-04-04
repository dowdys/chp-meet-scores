"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { cancelOrder, overrideOrderStatus, rebatchItem } from "@/lib/admin-actions";
import { formatPrice } from "@/lib/utils";
import { StatusBadge } from "@/components/admin/status-badge";
import type { OrderDetail } from "./order-detail-panel";
import type { AdminRole } from "@/lib/auth";

// ============================================================
// STATUS DISPLAY
// ============================================================

function statusColor(status: string) {
  return (
    status === "paid" ? "bg-green-100 text-green-700 border-green-200" :
    status === "shipped" ? "bg-blue-100 text-blue-700 border-blue-200" :
    status === "processing" ? "bg-yellow-100 text-yellow-700 border-yellow-200" :
    status === "delivered" ? "bg-green-200 text-green-800 border-green-300" :
    status === "refunded" || status === "cancelled" ? "bg-red-100 text-red-700 border-red-200" :
    "bg-gray-100 text-gray-700 border-gray-200"
  );
}

// ============================================================
// CANCEL / REFUND DIALOG
// ============================================================

const CANCELLABLE = ["paid", "processing"];
const IN_PRODUCTION = ["at_printer", "printed", "packed"];

function CancelDialog({
  order,
  onClose,
  onSuccess,
}: {
  order: OrderDetail;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const items = order.order_items || [];
  const isMultiItem = items.length > 1;

  const [selectedItemIds, setSelectedItemIds] = useState<number[]>([]);
  const [mode, setMode] = useState<"full" | "partial">("full");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Items that haven't already been cancelled
  const activeItems = items.filter((i) => i.production_status !== "cancelled");

  // Calculate refund amount for display
  function estimateRefund() {
    if (mode === "full") return order.total;

    const selected = activeItems.filter((i) => selectedItemIds.includes(i.id));
    const itemTotal = selected.reduce((sum, i) => sum + i.unit_price + i.jewel_price, 0);
    // Proportional shipping: calculate new shipping for remaining items
    const remainingCount = activeItems.length - selected.length;
    const newShipping = remainingCount > 0
      ? 525 + 290 * (remainingCount - 1) // SHIPPING_FIRST + SHIPPING_ADDITIONAL * (n-1)
      : 0;
    const shippingRefund = order.shipping_cost - newShipping;
    return itemTotal + Math.max(0, shippingRefund);
  }

  // Check if any selected items are in production
  const inProductionWarning = (() => {
    const check = mode === "full" ? activeItems : activeItems.filter((i) => selectedItemIds.includes(i.id));
    return check.some((i) => IN_PRODUCTION.includes(i.production_status));
  })();

  async function handleConfirm() {
    setLoading(true);
    setError(null);

    const itemIds = mode === "partial" ? selectedItemIds : undefined;

    // Partial cancel requires at least one selected item
    if (mode === "partial" && selectedItemIds.length === 0) {
      setError("Select at least one item to cancel.");
      setLoading(false);
      return;
    }

    const result = await cancelOrder(order.id, itemIds);
    setLoading(false);

    if (result.success) {
      onSuccess();
    } else {
      setError(result.error || "Failed to cancel order");
    }
  }

  function toggleItem(id: number) {
    setSelectedItemIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  const refundAmount = estimateRefund();

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-lg w-full max-h-[80vh] overflow-y-auto">
        <div className="p-6">
          <h3 className="text-lg font-semibold mb-1">Cancel &amp; Refund</h3>
          <p className="text-sm text-gray-500 mb-4">
            Order {order.order_number}
          </p>

          {/* Mode toggle for multi-item orders */}
          {isMultiItem && activeItems.length > 1 && (
            <div className="flex gap-2 mb-4">
              <button
                onClick={() => { setMode("full"); setSelectedItemIds([]); }}
                className={`px-3 py-1.5 text-xs font-medium rounded border ${
                  mode === "full"
                    ? "bg-red-50 border-red-200 text-red-700"
                    : "bg-gray-50 border-gray-200 text-gray-600"
                }`}
              >
                Full Cancel
              </button>
              <button
                onClick={() => setMode("partial")}
                className={`px-3 py-1.5 text-xs font-medium rounded border ${
                  mode === "partial"
                    ? "bg-red-50 border-red-200 text-red-700"
                    : "bg-gray-50 border-gray-200 text-gray-600"
                }`}
              >
                Partial Cancel
              </button>
            </div>
          )}

          {/* Item selection for partial cancel */}
          {mode === "partial" && (
            <div className="mb-4 border rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    <th className="p-2 w-8"></th>
                    <th className="text-left p-2 text-xs font-medium text-gray-500">Athlete</th>
                    <th className="text-left p-2 text-xs font-medium text-gray-500">Size</th>
                    <th className="text-left p-2 text-xs font-medium text-gray-500">Status</th>
                    <th className="text-right p-2 text-xs font-medium text-gray-500">Price</th>
                  </tr>
                </thead>
                <tbody>
                  {activeItems.map((item) => (
                    <tr
                      key={item.id}
                      className={`border-b last:border-b-0 cursor-pointer hover:bg-gray-50 ${
                        selectedItemIds.includes(item.id) ? "bg-red-50" : ""
                      }`}
                      onClick={() => toggleItem(item.id)}
                    >
                      <td className="p-2 text-center">
                        <input
                          type="checkbox"
                          checked={selectedItemIds.includes(item.id)}
                          onChange={() => toggleItem(item.id)}
                          className="rounded"
                        />
                      </td>
                      <td className="p-2 font-medium">
                        {item.corrected_name || item.athlete_name}
                      </td>
                      <td className="p-2">{item.shirt_size}</td>
                      <td className="p-2">
                        <StatusBadge status={item.production_status} type="item" />
                      </td>
                      <td className="p-2 text-right font-mono text-xs">
                        {formatPrice(item.unit_price + item.jewel_price)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Production warning */}
          {inProductionWarning && (
            <div className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
              <p className="text-sm text-yellow-800 font-medium">
                Warning: Items in production
              </p>
              <p className="text-xs text-yellow-700 mt-1">
                Some items are already at the printer or beyond. Cancelling them
                will not recall physical shirts.
              </p>
            </div>
          )}

          {/* Refund summary */}
          <div className="mb-4 p-3 bg-gray-50 rounded-lg">
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">Refund amount</span>
              <span className="font-semibold text-red-700">
                {formatPrice(refundAmount)}
              </span>
            </div>
            {mode === "partial" && selectedItemIds.length > 0 && (
              <p className="text-xs text-gray-500 mt-1">
                {selectedItemIds.length} item(s) + proportional shipping adjustment
              </p>
            )}
          </div>

          {/* Error */}
          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2">
            <button
              onClick={onClose}
              disabled={loading}
              className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200 disabled:opacity-50"
            >
              Go Back
            </button>
            <button
              onClick={handleConfirm}
              disabled={loading || (mode === "partial" && selectedItemIds.length === 0)}
              className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50"
            >
              {loading ? "Processing..." : `Refund ${formatPrice(refundAmount)}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// ORDER STATUS OVERRIDE DIALOG
// ============================================================

const ORDER_STATUSES = [
  "pending",
  "paid",
  "processing",
  "shipped",
  "delivered",
  "refunded",
  "cancelled",
];

function OverrideDialog({
  order,
  onClose,
  onSuccess,
}: {
  order: OrderDetail;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [newStatus, setNewStatus] = useState(order.status);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    if (!reason.trim()) {
      setError("A reason is required.");
      return;
    }
    if (newStatus === order.status) {
      onClose();
      return;
    }
    setLoading(true);
    setError(null);
    const result = await overrideOrderStatus(order.id, newStatus, reason);
    setLoading(false);
    if (result.success) {
      onSuccess();
    } else {
      setError(result.error || "Failed to override status");
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-md w-full">
        <div className="p-6">
          <h3 className="text-lg font-semibold mb-1">Override Order Status</h3>
          <p className="text-sm text-gray-500 mb-4">
            Order {order.order_number}
          </p>

          {/* Current status */}
          <div className="mb-4">
            <label className="block text-xs font-medium text-gray-500 mb-1">
              Current Status
            </label>
            <StatusBadge status={order.status} type="order" />
          </div>

          {/* New status */}
          <div className="mb-4">
            <label className="block text-xs font-medium text-gray-500 mb-1">
              New Status
            </label>
            <select
              value={newStatus}
              onChange={(e) => setNewStatus(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm"
              disabled={loading}
            >
              {ORDER_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>

          {/* Reason */}
          <div className="mb-4">
            <label className="block text-xs font-medium text-gray-500 mb-1">
              Reason (required)
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this status being changed?"
              rows={2}
              className="w-full border rounded-lg px-3 py-2 text-sm resize-none"
              disabled={loading}
            />
          </div>

          {/* Error */}
          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2">
            <button
              onClick={onClose}
              disabled={loading}
              className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={loading || newStatus === order.status}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {loading ? "Saving..." : "Override Status"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// RE-BATCH DIALOG (Unit 6)
// ============================================================

function RebatchDialog({
  order,
  onClose,
  onSuccess,
}: {
  order: OrderDetail;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const items = order.order_items || [];
  // Only show items that can be re-batched (not pending, not cancelled)
  const rebatchableItems = items.filter(
    (i) => i.production_status !== "pending" && i.production_status !== "cancelled"
  );
  const isMultiItem = rebatchableItems.length > 1;

  const [selectedItemIds, setSelectedItemIds] = useState<number[]>(
    rebatchableItems.length === 1 ? [rebatchableItems[0].id] : []
  );
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleItem(id: number) {
    setSelectedItemIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  async function handleConfirm() {
    if (!reason.trim()) {
      setError("A reason is required.");
      return;
    }
    if (selectedItemIds.length === 0) {
      setError("Select at least one item to re-batch.");
      return;
    }
    setLoading(true);
    setError(null);

    // Re-batch each selected item
    for (const itemId of selectedItemIds) {
      const result = await rebatchItem(itemId, reason);
      if (!result.success) {
        setError(result.error || "Failed to re-batch item");
        setLoading(false);
        return;
      }
    }

    setLoading(false);
    onSuccess();
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-lg w-full max-h-[80vh] overflow-y-auto">
        <div className="p-6">
          <h3 className="text-lg font-semibold mb-1">Re-batch Items</h3>
          <p className="text-sm text-gray-500 mb-4">
            Return items to pending for re-batching. Order {order.order_number}
          </p>

          {rebatchableItems.length === 0 ? (
            <div className="mb-4 p-3 bg-gray-50 rounded-lg">
              <p className="text-sm text-gray-600">
                No items available for re-batching. Items must be past the pending stage.
              </p>
            </div>
          ) : (
            <>
              {/* Item selection */}
              <div className="mb-4 border rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b">
                    <tr>
                      {isMultiItem && <th className="p-2 w-8"></th>}
                      <th className="text-left p-2 text-xs font-medium text-gray-500">Athlete</th>
                      <th className="text-left p-2 text-xs font-medium text-gray-500">Size</th>
                      <th className="text-left p-2 text-xs font-medium text-gray-500">Status</th>
                      <th className="text-left p-2 text-xs font-medium text-gray-500">Back</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rebatchableItems.map((item) => (
                      <tr
                        key={item.id}
                        className={`border-b last:border-b-0 ${
                          isMultiItem ? "cursor-pointer hover:bg-gray-50" : ""
                        } ${selectedItemIds.includes(item.id) ? "bg-orange-50" : ""}`}
                        onClick={isMultiItem ? () => toggleItem(item.id) : undefined}
                      >
                        {isMultiItem && (
                          <td className="p-2 text-center">
                            <input
                              type="checkbox"
                              checked={selectedItemIds.includes(item.id)}
                              onChange={() => toggleItem(item.id)}
                              className="rounded"
                            />
                          </td>
                        )}
                        <td className="p-2 font-medium">
                          {item.corrected_name || item.athlete_name}
                        </td>
                        <td className="p-2">{item.shirt_size}</td>
                        <td className="p-2">
                          <StatusBadge status={item.production_status} type="item" />
                        </td>
                        <td className="p-2 text-xs">
                          {item.shirt_backs?.level_group_label || "Unassigned"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Reason */}
              <div className="mb-4">
                <label className="block text-xs font-medium text-gray-500 mb-1">
                  Reason for re-batch (required)
                </label>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g., Defective print, wrong size, misspelled name"
                  rows={2}
                  className="w-full border rounded-lg px-3 py-2 text-sm resize-none"
                  disabled={loading}
                />
              </div>

              <div className="mb-4 p-3 bg-orange-50 border border-orange-200 rounded-lg">
                <p className="text-sm text-orange-800">
                  {selectedItemIds.length} item(s) will be returned to pending and
                  removed from their current batch. They will reappear on the By Back
                  page for inclusion in the next print batch.
                </p>
              </div>
            </>
          )}

          {/* Error */}
          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2">
            <button
              onClick={onClose}
              disabled={loading}
              className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200 disabled:opacity-50"
            >
              Cancel
            </button>
            {rebatchableItems.length > 0 && (
              <button
                onClick={handleConfirm}
                disabled={loading || selectedItemIds.length === 0 || !reason.trim()}
                className="px-4 py-2 text-sm font-medium text-white bg-orange-600 rounded-lg hover:bg-orange-700 disabled:opacity-50"
              >
                {loading ? "Processing..." : `Re-batch ${selectedItemIds.length} Item(s)`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// MAIN COMPONENT
// ============================================================

export function OrderActions({
  order,
  userRole = "admin",
}: {
  order: OrderDetail;
  userRole?: AdminRole;
}) {
  const router = useRouter();
  const [showCancel, setShowCancel] = useState(false);
  const [showOverride, setShowOverride] = useState(false);
  const [showRebatch, setShowRebatch] = useState(false);

  const canCancel = CANCELLABLE.includes(order.status);
  const hasRebatchableItems = order.order_items?.some(
    (i) => i.production_status !== "pending" && i.production_status !== "cancelled"
  );

  // Role-based visibility (Unit 9c)
  const isAdmin = userRole === "admin";
  const isShippingOrAdmin = userRole === "admin" || userRole === "shipping";

  function handleSuccess() {
    setShowCancel(false);
    setShowOverride(false);
    setShowRebatch(false);
    router.refresh();
  }

  // Viewer sees no action buttons at all
  if (userRole === "viewer") {
    return (
      <div className="mb-6">
        <div className={`rounded-lg border p-3 ${statusColor(order.status)}`}>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide opacity-70">Order Status</p>
              <p className="text-lg font-semibold capitalize">{order.status}</p>
            </div>
            <span className="font-mono text-sm opacity-70">{order.order_number}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-6">
      {/* Prominent status display */}
      <div className={`rounded-lg border p-3 mb-3 ${statusColor(order.status)}`}>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide opacity-70">Order Status</p>
            <p className="text-lg font-semibold capitalize">{order.status}</p>
          </div>
          <span className="font-mono text-sm opacity-70">{order.order_number}</span>
        </div>
      </div>

      {/* Action buttons — role-gated */}
      <div className="flex gap-2">
        {isAdmin && (
          <button
            onClick={() => setShowCancel(true)}
            disabled={!canCancel}
            className={`px-3 py-1.5 rounded text-xs font-medium border ${
              canCancel
                ? "bg-red-50 text-red-700 border-red-200 hover:bg-red-100"
                : "bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed"
            }`}
            title={canCancel ? "Cancel and refund this order" : `Cannot cancel a ${order.status} order`}
          >
            Cancel &amp; Refund
          </button>
        )}
        {isAdmin && (
          <button
            onClick={() => setShowOverride(true)}
            className="px-3 py-1.5 rounded text-xs font-medium bg-gray-50 text-gray-700 border border-gray-200 hover:bg-gray-100"
          >
            Override Status
          </button>
        )}
        {isAdmin && (
          <button
            onClick={() => setShowRebatch(true)}
            disabled={!hasRebatchableItems}
            className={`px-3 py-1.5 rounded text-xs font-medium border ${
              hasRebatchableItems
                ? "bg-orange-50 text-orange-700 border-orange-200 hover:bg-orange-100"
                : "bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed"
            }`}
            title={hasRebatchableItems ? "Return items to pending for re-batching" : "No items available for re-batch"}
          >
            Re-batch
          </button>
        )}
        {isShippingOrAdmin && !isAdmin && (
          <p className="text-xs text-gray-400 italic self-center">
            Shipping role: view-only for order actions
          </p>
        )}
      </div>

      {/* Cancel dialog */}
      {showCancel && (
        <CancelDialog
          order={order}
          onClose={() => setShowCancel(false)}
          onSuccess={handleSuccess}
        />
      )}

      {/* Override dialog */}
      {showOverride && (
        <OverrideDialog
          order={order}
          onClose={() => setShowOverride(false)}
          onSuccess={handleSuccess}
        />
      )}

      {/* Re-batch dialog */}
      {showRebatch && (
        <RebatchDialog
          order={order}
          onClose={() => setShowRebatch(false)}
          onSuccess={handleSuccess}
        />
      )}
    </div>
  );
}
