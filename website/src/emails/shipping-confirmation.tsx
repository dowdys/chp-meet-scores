import {
  Html,
  Head,
  Body,
  Container,
  Text,
  Hr,
  Link,
} from "@react-email/components";

interface ShippingConfirmationProps {
  orderNumber: string;
  customerName: string;
  trackingNumber: string;
  carrier: string;
}

export function ShippingConfirmationEmail({
  orderNumber = "CHP-2026-A7K3F001",
  customerName = "Jane Doe",
  trackingNumber = "1Z999AA10123456789",
  carrier = "USPS",
}: ShippingConfirmationProps) {
  return (
    <Html>
      <Head />
      <Body
        style={{
          fontFamily: "Arial, sans-serif",
          backgroundColor: "#f5f5f5",
          margin: 0,
          padding: "20px",
        }}
      >
        <Container
          style={{
            maxWidth: "500px",
            margin: "0 auto",
            backgroundColor: "#ffffff",
            borderRadius: "8px",
            padding: "32px",
          }}
        >
          <Text style={{ fontSize: "24px", fontWeight: "bold", margin: 0 }}>
            Your Order Has Shipped!
          </Text>
          <Text style={{ color: "#666", marginTop: "8px" }}>
            Hi {customerName}, your championship shirt is on its way!
          </Text>

          <Hr style={{ margin: "20px 0", borderColor: "#eee" }} />

          <Text style={{ fontWeight: "bold" }}>Order #{orderNumber}</Text>
          <Text style={{ fontSize: "14px", color: "#666" }}>
            Carrier: {carrier}
          </Text>
          <Text style={{ fontSize: "14px", fontFamily: "monospace" }}>
            Tracking: {trackingNumber}
          </Text>

          <Link
            href="https://thestatechampion.com/order-status"
            style={{
              display: "inline-block",
              backgroundColor: "#FFD700",
              color: "#000",
              padding: "12px 24px",
              borderRadius: "8px",
              fontWeight: "bold",
              textDecoration: "none",
              marginTop: "16px",
            }}
          >
            Track Your Order
          </Link>

          <Hr style={{ margin: "24px 0", borderColor: "#eee" }} />

          <Text style={{ fontSize: "12px", color: "#999", textAlign: "center" as const }}>
            The State Champion | thestatechampion.com
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
