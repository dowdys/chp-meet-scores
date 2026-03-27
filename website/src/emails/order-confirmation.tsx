import {
  Html,
  Head,
  Body,
  Container,
  Text,
  Section,
  Hr,
  Link,
} from "@react-email/components";

interface OrderConfirmationProps {
  orderNumber: string;
  customerName: string;
  items: Array<{
    athleteName: string;
    shirtSize: string;
    shirtColor: string;
    hasJewel: boolean;
  }>;
  total: string;
  shippingAddress: string;
}

export function OrderConfirmationEmail({
  orderNumber = "CHP-2026-A7K3F001",
  customerName = "Jane Doe",
  items = [
    { athleteName: "Emma Smith", shirtSize: "YM", shirtColor: "white", hasJewel: false },
  ],
  total = "$27.95",
  shippingAddress = "123 Main St, Springfield, IL 62701",
}: OrderConfirmationProps) {
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
            Order Confirmed!
          </Text>
          <Text style={{ color: "#666", marginTop: "8px" }}>
            Hi {customerName}, thank you for your order.
          </Text>

          <Hr style={{ margin: "20px 0", borderColor: "#eee" }} />

          <Text style={{ fontWeight: "bold", marginBottom: "8px" }}>
            Order #{orderNumber}
          </Text>

          <Section>
            {items.map((item, i) => (
              <Text
                key={i}
                style={{
                  margin: "4px 0",
                  padding: "8px",
                  backgroundColor: "#f9f9f9",
                  borderRadius: "4px",
                  fontSize: "14px",
                }}
              >
                {item.athleteName} — {item.shirtSize} {item.shirtColor}
                {item.hasJewel ? " + Jewel" : ""}
              </Text>
            ))}
          </Section>

          <Hr style={{ margin: "20px 0", borderColor: "#eee" }} />

          <Text style={{ fontWeight: "bold" }}>Total: {total}</Text>
          <Text style={{ fontSize: "14px", color: "#666" }}>
            Shipping to: {shippingAddress}
          </Text>

          <Text
            style={{ fontSize: "14px", color: "#666", marginTop: "20px" }}
          >
            Your championship shirt will be screen-printed and shipped
            directly to you. We&apos;ll send tracking info when it ships.
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
