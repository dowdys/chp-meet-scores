import {
  Html,
  Head,
  Body,
  Container,
  Text,
  Hr,
  Link,
} from "@react-email/components";

interface ResultsReadyProps {
  athleteName: string;
  state: string;
}

export function ResultsReadyEmail({
  athleteName = "Emma Smith",
  state = "Nevada",
}: ResultsReadyProps) {
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
            Results Are Ready!
          </Text>
          <Text style={{ color: "#666", marginTop: "8px" }}>
            Great news! The {state} championship results have been
            processed.
          </Text>

          <Text style={{ marginTop: "16px" }}>
            We have results for <strong>{athleteName}</strong>. You can now
            order their championship shirt!
          </Text>

          <Text style={{ fontSize: "14px", color: "#666", marginTop: "12px" }}>
            Your gym should also be receiving order forms with personalized
            QR codes in the mail soon.
          </Text>

          <Link
            href="https://thestatechampion.com/find"
            style={{
              display: "inline-block",
              backgroundColor: "#FFD700",
              color: "#000",
              padding: "12px 24px",
              borderRadius: "8px",
              fontWeight: "bold",
              textDecoration: "none",
              marginTop: "20px",
            }}
          >
            Order Championship Shirt
          </Link>

          <Hr style={{ margin: "24px 0", borderColor: "#eee" }} />

          <Text style={{ fontSize: "12px", color: "#999", textAlign: "center" as const }}>
            The State Champion | thestatechampion.com
            {"\n"}
            You received this because you signed up for result notifications.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
