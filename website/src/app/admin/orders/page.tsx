import { getOrders, getOrderDetail } from "@/lib/admin";
import { getUserRole } from "@/lib/auth";
import { formatPrice } from "@/lib/utils";
import { StatusBadge } from "@/components/admin/status-badge";
import { OrderFilters } from "./order-filters";
import { OrderDetailPanel } from "./order-detail-panel";
import { CSVExportButton } from "@/components/admin/csv-export-button";
import { OrderRowLink } from "./order-row-link";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ status?: string; search?: string; order?: string }>;
}

export default async function OrdersPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const [{ data: orders }, userRole] = await Promise.all([
    getOrders({
      status: params.status,
      search: params.search,
      limit: 200,
    }),
    getUserRole(),
  ]);

  // If an order is selected, fetch its full details
  const orderDetail = params.order
    ? (await getOrderDetail(params.order)).data
    : null;

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">All Orders</h1>
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-500">{orders.length} orders</span>
          <CSVExportButton
            data={orders.map((o: any) => ({
              order_number: o.order_number,
              customer: o.customer_name,
              email: o.customer_email,
              items: o.order_items?.length || 0,
              total: (o.total / 100).toFixed(2),
              status: o.status,
              date: new Date(o.created_at).toLocaleDateString(),
            }))}
            filename={`orders-${new Date().toISOString().split("T")[0]}.csv`}
          />
        </div>
      </div>

      <OrderFilters currentStatus={params.status} currentSearch={params.search} />

      <div className="bg-white rounded-xl border overflow-hidden mt-4">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left p-3">Order #</th>
              <th className="text-left p-3">Customer</th>
              <th className="text-left p-3">Items</th>
              <th className="text-left p-3">Total</th>
              <th className="text-left p-3">Status</th>
              <th className="text-left p-3">Date</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order: any) => (
              <OrderRowLink key={order.id} orderNumber={order.order_number}>
                <td className="p-3 font-mono text-xs">{order.order_number}</td>
                <td className="p-3">
                  <div>{order.customer_name}</div>
                  <div className="text-xs text-gray-400">{order.customer_email}</div>
                </td>
                <td className="p-3">{order.order_items?.length || 0} shirts</td>
                <td className="p-3 font-medium">{formatPrice(order.total)}</td>
                <td className="p-3">
                  <StatusBadge status={order.status} type="order" />
                </td>
                <td className="p-3 text-gray-500">
                  {new Date(order.created_at).toLocaleDateString()}
                </td>
              </OrderRowLink>
            ))}
            {orders.length === 0 && (
              <tr>
                <td colSpan={6} className="p-8 text-center text-gray-400">
                  No orders found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Order detail slide-over panel */}
      <OrderDetailPanel order={orderDetail} userRole={userRole || "viewer"} />
    </div>
  );
}
