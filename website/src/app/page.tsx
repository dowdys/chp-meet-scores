import Link from "next/link";

export default function HomePage() {
  return (
    <div className="min-h-screen bg-white text-gray-900 dark:bg-black dark:text-white">
      {/* Header */}
      <header className="flex items-center justify-between p-6 max-w-6xl mx-auto">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            THE STATE <span className="text-red-500">CHAMPION</span>
          </h1>
          <p className="text-[10px] tracking-[0.3em] text-gray-400 uppercase">
            Honoring State Champion Gymnasts
          </p>
        </div>
        <nav className="flex gap-6 text-sm">
          <Link href="/find" className="hover:text-red-400 transition">
            Order Shirt
          </Link>
          <Link href="/order-status" className="hover:text-red-400 transition">
            Track Order
          </Link>
          <Link href="/privacy" className="hover:text-red-400 transition text-gray-500">
            Privacy
          </Link>
        </nav>
      </header>

      {/* Hero */}
      <main>
        <section className="max-w-5xl mx-auto px-6 py-16 md:py-24">
          <div className="text-center">
            <p className="text-red-500 text-sm font-semibold tracking-widest uppercase mb-4">
              2026 Championship Season
            </p>
            <h2 className="text-4xl md:text-6xl font-bold mb-6 leading-tight">
              Your Champion Deserves a{" "}
              <span className="text-red-500">Championship Shirt</span>
            </h2>
            <p className="text-lg md:text-xl text-gray-400 mb-10 max-w-2xl mx-auto">
              Celebrate your gymnast&apos;s achievements with an official
              championship t-shirt featuring their name alongside all the state winners.
            </p>

            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link
                href="/find"
                className="bg-red-600 text-white px-10 py-4 rounded text-lg font-bold hover:bg-red-500 transition shadow-lg shadow-red-900/30"
              >
                Find Your Champion
              </Link>
              <Link
                href="/order-status"
                className="border border-gray-300 dark:border-gray-700 text-gray-300 px-10 py-4 rounded text-lg hover:bg-white/5 transition"
              >
                Track Your Order
              </Link>
            </div>
          </div>
        </section>

        {/* Features */}
        <section className="border-t border-gray-200 dark:border-gray-800">
          <div className="max-w-5xl mx-auto px-6 py-16">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-10">
              <div className="text-center">
                <div className="w-14 h-14 bg-red-600/10 rounded-full flex items-center justify-center mx-auto mb-4">
                  <span className="text-red-500 text-2xl font-bold">1</span>
                </div>
                <h3 className="font-bold text-lg mb-2">Find Your Athlete</h3>
                <p className="text-gray-500 dark:text-gray-400 text-sm leading-relaxed">
                  Search by state, gym, and name — or scan the QR code on your
                  order form mailed to your gym.
                </p>
              </div>
              <div className="text-center">
                <div className="w-14 h-14 bg-red-600/10 rounded-full flex items-center justify-center mx-auto mb-4">
                  <span className="text-red-500 text-2xl font-bold">2</span>
                </div>
                <h3 className="font-bold text-lg mb-2">Choose Your Shirt</h3>
                <p className="text-gray-500 dark:text-gray-400 text-sm leading-relaxed">
                  Pick your size and color. Add a jewel rhinestone accent.
                  Order for the whole family.
                </p>
              </div>
              <div className="text-center">
                <div className="w-14 h-14 bg-red-600/10 rounded-full flex items-center justify-center mx-auto mb-4">
                  <span className="text-red-500 text-2xl font-bold">3</span>
                </div>
                <h3 className="font-bold text-lg mb-2">Shipped to Your Door</h3>
                <p className="text-gray-500 dark:text-gray-400 text-sm leading-relaxed">
                  We screen-print your championship shirt and ship it directly
                  to you with tracking included.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Pricing */}
        <section className="border-t border-gray-200 dark:border-gray-800">
          <div className="max-w-3xl mx-auto px-6 py-16 text-center">
            <h3 className="text-2xl font-bold mb-8">Simple Pricing</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
              <div className="bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-6">
                <p className="text-gray-400 text-sm mb-1">Championship T-Shirt</p>
                <p className="text-4xl font-bold">
                  $27<span className="text-xl">.95</span>
                </p>
                <p className="text-gray-500 text-xs mt-2">White or grey</p>
              </div>
              <div className="bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-6">
                <p className="text-gray-400 text-sm mb-1">Jewel Accent Add-On</p>
                <p className="text-4xl font-bold">
                  +$4<span className="text-xl">.50</span>
                </p>
                <p className="text-gray-500 text-xs mt-2">Rhinestone crystal on design</p>
              </div>
            </div>
            <p className="text-gray-500 dark:text-gray-600 text-xs mt-4">
              Shipping: $5.25 first shirt + $2.90 each additional. Tax calculated at checkout.
            </p>
          </div>
        </section>

        {/* Footer */}
        <footer className="border-t border-gray-200 dark:border-gray-800 py-8">
          <div className="max-w-5xl mx-auto px-6 flex flex-col sm:flex-row justify-between items-center gap-4">
            <div className="text-sm text-gray-600">
              &copy; {new Date().getFullYear()} The State Champion / C.H. Publishing
            </div>
            <div className="flex gap-6 text-sm text-gray-600">
              <Link href="/privacy" className="hover:text-gray-400">
                Privacy Policy
              </Link>
              <Link href="/email-capture" className="hover:text-gray-400">
                Get Notified
              </Link>
            </div>
          </div>
        </footer>
      </main>
    </div>
  );
}
