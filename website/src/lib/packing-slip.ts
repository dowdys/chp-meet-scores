import "server-only";

interface PackingSlipOrder {
  order_number: string;
  customer_name: string;
  shipping_address: string;
  items: Array<{
    athlete_name: string;
    corrected_name?: string | null;
    shirt_size: string;
    shirt_color: string;
    has_jewel: boolean;
    meet_name: string;
  }>;
}

export function generatePackingSlipHTML(order: PackingSlipOrder): string {
  const itemRows = order.items
    .map(
      (item) =>
        `<tr>
      <td style="padding:4px 8px;border-bottom:1px solid #eee">
        ${item.corrected_name || item.athlete_name}
        ${item.corrected_name ? `<em style="color:#888">(was: ${item.athlete_name})</em>` : ""}
      </td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee">${item.shirt_size}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee">${item.shirt_color}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;font-weight:bold">${item.has_jewel ? "YES" : ""}</td>
      <td style="padding:4px 8px;border-bottom:1px solid #eee;font-size:11px">${item.meet_name}</td>
    </tr>`
    )
    .join("");

  const jewelCount = order.items.filter((i) => i.has_jewel).length;

  return `<!DOCTYPE html>
<html>
<head><title>Packing Slip - ${order.order_number}</title></head>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
  <h2 style="margin:0">The State Champion</h2>
  <p style="color:#888;margin:4px 0 20px">Packing Slip</p>
  <table style="width:100%;margin-bottom:20px">
    <tr>
      <td><strong>Order:</strong> ${order.order_number}</td>
      <td style="text-align:right"><strong>Date:</strong> ${new Date().toLocaleDateString()}</td>
    </tr>
  </table>
  <p><strong>Ship to:</strong> ${order.customer_name}<br>${order.shipping_address}</p>
  <table style="width:100%;border-collapse:collapse;margin-top:16px">
    <thead>
      <tr style="background:#f5f5f5">
        <th style="text-align:left;padding:6px 8px">Athlete</th>
        <th style="text-align:left;padding:6px 8px">Size</th>
        <th style="text-align:left;padding:6px 8px">Color</th>
        <th style="text-align:left;padding:6px 8px">Jewel</th>
        <th style="text-align:left;padding:6px 8px">Meet</th>
      </tr>
    </thead>
    <tbody>${itemRows}</tbody>
  </table>
  <p style="margin-top:24px;font-size:12px;color:#888">
    Items: ${order.items.length} | Jewels: ${jewelCount}
  </p>
</body>
</html>`;
}
