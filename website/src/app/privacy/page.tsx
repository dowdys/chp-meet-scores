import Link from "next/link";

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-white">
      <header className="p-6 max-w-3xl mx-auto">
        <Link href="/" className="text-xl font-bold text-gray-900">
          The State Champion
        </Link>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-8 prose prose-gray">
        <h1>Privacy Policy</h1>
        <p className="text-sm text-gray-500">
          Last updated: {new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
        </p>

        <h2>Information We Collect</h2>
        <p>
          When you place an order, we collect your name, email address, phone
          number (optional), and shipping address. We also display publicly
          available athletic competition results including athlete names, gym
          affiliations, competition levels, and scores.
        </p>

        <h2>Children&apos;s Privacy (COPPA)</h2>
        <p>
          Our service involves championship t-shirts for gymnasts, many of whom
          are minors. We do not knowingly collect personal information directly
          from children under 13. Orders are placed by parents or guardians.
          Competition results displayed on our site are publicly available
          records from gymnastics meets.
        </p>
        <p>
          Personalized celebration pages are accessible only via unique,
          non-indexed URLs (QR codes). These pages are not indexed by search
          engines and do not appear in search results.
        </p>
        <p>
          If you are a parent or guardian and believe we have inadvertently
          collected personal information from your child, please contact us
          and we will promptly delete it.
        </p>

        <h2>How We Use Your Information</h2>
        <ul>
          <li>To process and fulfill your t-shirt orders</li>
          <li>To send order confirmation and shipping notification emails</li>
          <li>To notify you when championship results are ready (if you signed up)</li>
          <li>To display personalized celebration pages for championship winners</li>
        </ul>

        <h2>Information Sharing</h2>
        <p>
          We share your information only with service providers necessary to
          fulfill your order:
        </p>
        <ul>
          <li><strong>Stripe</strong> — payment processing</li>
          <li><strong>EasyPost / USPS</strong> — shipping and delivery</li>
          <li><strong>Postmark</strong> — email delivery</li>
        </ul>
        <p>We do not sell your personal information to third parties.</p>

        <h2>Data Retention</h2>
        <p>
          We retain order information for as long as needed to fulfill orders
          and comply with legal obligations. Email notification signups are
          retained until you unsubscribe or request deletion.
        </p>

        <h2>Your Rights</h2>
        <p>You may request to:</p>
        <ul>
          <li>Access the personal information we hold about you</li>
          <li>Correct inaccurate information</li>
          <li>Delete your personal information</li>
          <li>Opt out of marketing communications</li>
        </ul>

        <h2>Contact Us</h2>
        <p>
          For privacy questions or requests, contact us at:{" "}
          <a href="mailto:privacy@thestatechampion.com">
            privacy@thestatechampion.com
          </a>
        </p>
      </main>
    </div>
  );
}
