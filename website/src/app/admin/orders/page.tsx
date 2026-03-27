import { getOrders } from "@/lib/admin";
import { formatPrice } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function OrdersPage() {
  const { data: orders } = await getOrders({ limit: 100 });

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">All Orders</h1>
        <span className="text-sm text-gray-500">{orders.length} orders</span>
      </div>

      <div className="bg-white rounded-xl border overflow-hidden">
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
              <tr key={order.id} className="border-b hover:bg-gray-50">
                <td className="p-3 font-mono text-xs">{order.order_number}</td>
                <td className="p-3">
                  <div>{order.customer_name}</div>
                  <div className="text-xs text-gray-400">{order.customer_email}</div>
                </td>
                <td className="p-3">{order.order_items?.length || 0} shirts</td>
                <td className="p-3 font-medium">{formatPrice(order.total)}</td>
                <td className="p-3">
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                    order.status === "paid" ? "bg-green-100 text-green-700" :
                    order.status === "shipped" ? "bg-blue-100 text-blue-700" :
                    order.status === "processing" ? "bg-yellow-100 text-yellow-700" :
                    "bg-gray-100 text-gray-700"
                  }`}>
                    {order.status}
                  </span>
                </td>
                <td className="p-3 text-gray-500">
                  {new Date(order.created_at).toLocaleDateString()}
                </td>
              </tr>
            ))}
            {orders.length === 0 && (
              <tr>
                <td colSpan={6} className="p-8 text-center text-gray-400">
                  No orders yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
