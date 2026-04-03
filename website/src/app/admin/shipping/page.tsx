import { getShippingQueue, getPartiallyPrintedOrders } from "@/lib/admin";
import { getUserRole } from "@/lib/auth";
import { StatusBadge } from "@/components/admin/status-badge";
import { ShipAction } from "./ship-actions";

export const dynamic = "force-dynamic";

export default async function ShippingPage() {
  const [{ data: orders }, { data: partialOrders }, userRole] = await Promise.all([
    getShippingQueue(),
    getPartiallyPrintedOrders(),
    getUserRole(),
  ]);

  const canCreateLabels = userRole === "admin" || userRole === "shipping";

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Shipping Queue</h1>
        <span className="text-sm text-gray-500">{orders.length} ready to ship</span>
      </div>

      <div className="bg-white rounded-xl border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left p-3">Order #</th>
              <th className="text-left p-3">Customer</th>
              <th className="text-left p-3">Ship To</th>
              <th className="text-left p-3">Items</th>
              <th className="text-left p-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order: any) => (
              <tr key={order.id} className="border-b hover:bg-gray-50">
                <td className="p-3 font-mono text-xs">{order.order_number}</td>
                <td className="p-3">{order.customer_name}</td>
                <td className="p-3 text-xs">
                  {order.shipping_city}, {order.shipping_state} {order.shipping_zip}
                </td>
                <td className="p-3">{order.order_items?.length || 0} shirts</td>
                <td className="p-3">
                  {canCreateLabels ? (
                    <ShipAction orderId={order.id} />
                  ) : (
                    <span className="text-xs text-gray-400">View only</span>
                  )}
                </td>
              </tr>
            ))}
            {orders.length === 0 && (
              <tr>
                <td colSpan={5} className="p-8 text-center text-gray-400">
                  No orders ready to ship
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Partially-printed orders — waiting on production (Unit 7f) */}
      {partialOrders.length > 0 && (
        <div className="mt-8">
          <h2 className="text-lg font-semibold mb-2">Waiting on Production</h2>
          <p className="text-sm text-gray-500 mb-4">
            These orders have some items printed but are waiting for other items
            still in production.
          </p>

          <div className="bg-white rounded-xl border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="text-left p-3">Order #</th>
                  <th className="text-left p-3">Customer</th>
                  <th className="text-left p-3">Items Status</th>
                </tr>
              </thead>
              <tbody>
                {partialOrders.map((order: any) => {
                  const items = (order.order_items || []).filter(
                    (i: any) => i.production_status !== "cancelled"
                  );
                  const printedCount = items.filter(
                    (i: any) => i.production_status === "printed" || i.production_status === "packed"
                  ).length;
                  const remaining = items.filter(
                    (i: any) => i.production_status !== "printed" && i.production_status !== "packed"
                  );

                  return (
                    <tr key={order.id} className="border-b hover:bg-gray-50">
                      <td className="p-3 font-mono text-xs">{order.order_number}</td>
                      <td className="p-3">{order.customer_name}</td>
                      <td className="p-3">
                        <div className="flex flex-col gap-1">
                          <span className="text-xs text-green-700">
                            {printedCount} of {items.length} printed
                          </span>
                          <div className="flex gap-1 flex-wrap">
                            {remaining.map((item: any) => (
                              <span key={item.id} className="flex items-center gap-1">
                                <StatusBadge status={item.production_status} type="item" />
                                {item.printer_batches?.batch_name && (
                                  <span className="text-xs text-gray-400">
                                    ({item.printer_batches.batch_name})
                                  </span>
                                )}
                              </span>
                            ))}
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
