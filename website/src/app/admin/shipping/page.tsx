import { getShippingQueue } from "@/lib/admin";
import { formatPrice } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function ShippingPage() {
  const { data: orders } = await getShippingQueue();

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
                  <button className="bg-blue-500 text-white px-3 py-1 rounded text-xs hover:bg-blue-600">
                    Create Label
                  </button>
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
    </div>
  );
}
