"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect } from "react";
import { formatPrice } from "@/lib/utils";
import { OrderActions } from "./order-actions";
import { StatusBadge } from "@/components/admin/status-badge";
import type { AdminRole } from "@/lib/auth";

interface OrderItem {
  id: number;
  athlete_name: string;
  corrected_name: string | null;
  shirt_size: string;
  shirt_color: string;
  has_jewel: boolean;
  unit_price: number;
  jewel_price: number;
  production_status: string;
  shirt_backs: { id: number; meet_name: string; level_group_label: string } | null;
}

interface StatusHistoryEntry {
  id: number;
  old_status: string | null;
  new_status: string;
  changed_by: string | null;
  reason: string | null;
  created_at: string;
}

export interface OrderDetail {
  id: number;
  order_number: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string | null;
  shipping_name: string;
  shipping_address_line1: string;
  shipping_address_line2: string | null;
  shipping_city: string;
  shipping_state: string;
  shipping_zip: string;
  subtotal: number;
  shipping_cost: number;
  tax: number;
  total: number;
  status: string;
  tracking_number: string | null;
  carrier: string | null;
  paid_at: string | null;
  shipped_at: string | null;
  created_at: string;
  order_items: OrderItem[];
  status_history: StatusHistoryEntry[];
}

export function OrderDetailPanel({
  order,
  userRole = "admin",
}: {
  order: OrderDetail | null;
  userRole?: AdminRole;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedOrder = searchParams.get("order");

  const close = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("order");
    const remaining = params.toString();
    router.push(`/admin/orders${remaining ? `?${remaining}` : ""}`);
  }, [router, searchParams]);

  // Close on Escape key
  useEffect(() => {
    if (!selectedOrder) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [selectedOrder, close]);

  // No order selected — don't render anything
  if (!selectedOrder) return null;

  // Order param is set but order wasn't found
  if (!order) {
    return (
      <>
        {/* Backdrop */}
        <div className="fixed inset-0 bg-black/30 z-40" onClick={close} />
        {/* Panel */}
        <div className="fixed inset-y-0 right-0 w-full max-w-2xl bg-white shadow-xl z-50 overflow-y-auto">
          <div className="p-6">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-lg font-semibold">Order Not Found</h2>
              <button onClick={close} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">&times;</button>
            </div>
            <p className="text-gray-500">Order &quot;{selectedOrder}&quot; was not found.</p>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/30 z-40" onClick={close} />

      {/* Slide-over panel */}
      <div className="fixed inset-y-0 right-0 w-full max-w-2xl bg-white shadow-xl z-50 overflow-y-auto">
        <div className="p-6">
          {/* Header */}
          <div className="flex justify-between items-center mb-6">
            <div>
              <h2 className="text-lg font-semibold">{order!.order_number}</h2>
              <p className="text-sm text-gray-500">
                {new Date(order!.created_at).toLocaleDateString("en-US", {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </p>
            </div>
            <button
              onClick={close}
              className="text-gray-400 hover:text-gray-600 text-2xl leading-none"
            >
              &times;
            </button>
          </div>

          {/* Order Actions (status + action buttons) */}
          <OrderActions order={order!} userRole={userRole} />

          {/* Customer Info */}
          <section className="mb-6">
            <h3 className="text-sm font-semibold text-gray-700 mb-2">Customer</h3>
            <div className="bg-gray-50 rounded-lg p-4 text-sm space-y-1">
              <p className="font-medium">{order!.customer_name}</p>
              <p className="text-gray-600">{order!.customer_email}</p>
              {order!.customer_phone && (
                <p className="text-gray-600">{order!.customer_phone}</p>
              )}
            </div>
          </section>

          {/* Shipping Address */}
          <section className="mb-6">
            <h3 className="text-sm font-semibold text-gray-700 mb-2">Shipping Address</h3>
            <div className="bg-gray-50 rounded-lg p-4 text-sm space-y-1">
              <p>{order!.shipping_name}</p>
              <p>{order!.shipping_address_line1}</p>
              {order!.shipping_address_line2 && (
                <p>{order!.shipping_address_line2}</p>
              )}
              <p>
                {order!.shipping_city}, {order!.shipping_state} {order!.shipping_zip}
              </p>
            </div>
          </section>

          {/* Tracking Info */}
          {order!.tracking_number && (
            <section className="mb-6">
              <h3 className="text-sm font-semibold text-gray-700 mb-2">Tracking</h3>
              <div className="bg-blue-50 rounded-lg p-4 text-sm space-y-1">
                <p>
                  <span className="text-gray-600">Carrier:</span>{" "}
                  <span className="font-medium">{order!.carrier || "USPS"}</span>
                </p>
                <p>
                  <span className="text-gray-600">Tracking #:</span>{" "}
                  <span className="font-mono text-xs">{order!.tracking_number}</span>
                </p>
              </div>
            </section>
          )}

          {/* Order Items */}
          <section className="mb-6">
            <h3 className="text-sm font-semibold text-gray-700 mb-2">
              Items ({order!.order_items.length})
            </h3>
            {order!.order_items.length === 0 ? (
              <p className="text-sm text-gray-400 italic">No items in this order.</p>
            ) : (
              <div className="bg-white rounded-lg border overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b">
                    <tr>
                      <th className="text-left p-2 text-xs font-medium text-gray-500">Athlete</th>
                      <th className="text-left p-2 text-xs font-medium text-gray-500">Size</th>
                      <th className="text-left p-2 text-xs font-medium text-gray-500">Color</th>
                      <th className="text-left p-2 text-xs font-medium text-gray-500">Jewel</th>
                      <th className="text-left p-2 text-xs font-medium text-gray-500">Back</th>
                      <th className="text-left p-2 text-xs font-medium text-gray-500">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {order!.order_items.map((item) => (
                      <tr key={item.id} className="border-b last:border-b-0">
                        <td className="p-2">
                          <div>
                            {item.corrected_name ? (
                              <>
                                <span className="font-medium">{item.corrected_name}</span>
                                <span className="text-xs text-gray-400 line-through ml-1">
                                  {item.athlete_name}
                                </span>
                              </>
                            ) : (
                              <span className="font-medium">{item.athlete_name}</span>
                            )}
                          </div>
                        </td>
                        <td className="p-2">{item.shirt_size}</td>
                        <td className="p-2 capitalize">{item.shirt_color}</td>
                        <td className="p-2">
                          {item.has_jewel ? (
                            <span className="text-purple-600 font-medium">Yes</span>
                          ) : (
                            <span className="text-gray-400">No</span>
                          )}
                        </td>
                        <td className="p-2 text-xs">
                          {item.shirt_backs?.level_group_label || (
                            <span className="text-gray-400 italic">Unassigned</span>
                          )}
                        </td>
                        <td className="p-2">
                          <StatusBadge status={item.production_status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Payment Info */}
          <section className="mb-6">
            <h3 className="text-sm font-semibold text-gray-700 mb-2">Payment</h3>
            <div className="bg-gray-50 rounded-lg p-4 text-sm space-y-2">
              <div className="flex justify-between">
                <span className="text-gray-600">Subtotal</span>
                <span>{formatPrice(order!.subtotal)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Shipping</span>
                <span>{formatPrice(order!.shipping_cost)}</span>
              </div>
              {order!.tax > 0 && (
                <div className="flex justify-between">
                  <span className="text-gray-600">Tax</span>
                  <span>{formatPrice(order!.tax)}</span>
                </div>
              )}
              <div className="flex justify-between border-t pt-2 font-semibold">
                <span>Total</span>
                <span>{formatPrice(order!.total)}</span>
              </div>
              {order!.paid_at && (
                <p className="text-xs text-gray-400 pt-1">
                  Paid {new Date(order!.paid_at).toLocaleDateString("en-US", {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </p>
              )}
            </div>
          </section>

          {/* Status History */}
          <section className="mb-6">
            <h3 className="text-sm font-semibold text-gray-700 mb-2">Status History</h3>
            {order!.status_history.length === 0 ? (
              <p className="text-sm text-gray-400 italic">No status changes recorded.</p>
            ) : (
              <div className="space-y-3">
                {order!.status_history.map((entry) => (
                  <div key={entry.id} className="flex gap-3 text-sm">
                    <div className="flex flex-col items-center">
                      <div className="w-2 h-2 rounded-full bg-gray-400 mt-1.5" />
                      <div className="w-px flex-1 bg-gray-200" />
                    </div>
                    <div className="pb-3">
                      <div className="flex items-center gap-2">
                        {entry.old_status && (
                          <>
                            <StatusBadge status={entry.old_status} />
                            <span className="text-gray-400">&rarr;</span>
                          </>
                        )}
                        <StatusBadge status={entry.new_status} />
                      </div>
                      {entry.reason && (
                        <p className="text-gray-600 mt-0.5">{entry.reason}</p>
                      )}
                      <p className="text-xs text-gray-400 mt-0.5">
                        {new Date(entry.created_at).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                        {entry.changed_by && ` by ${entry.changed_by}`}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
