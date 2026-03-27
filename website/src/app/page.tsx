import Link from "next/link";

export default function HomePage() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-900 to-black text-white">
      <header className="flex items-center justify-between p-6 max-w-6xl mx-auto">
        <h1 className="text-xl font-bold">The State Champion</h1>
        <nav className="flex gap-4 text-sm">
          <Link href="/find" className="hover:text-yellow-400">
            Find Your Champion
          </Link>
          <Link href="/order-status" className="hover:text-yellow-400">
            Track Order
          </Link>
        </nav>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-20 text-center">
        <h2 className="text-5xl font-bold mb-6">
          Your Champion Deserves a{" "}
          <span className="text-yellow-400">Championship Shirt</span>
        </h2>
        <p className="text-xl text-gray-300 mb-10 max-w-2xl mx-auto">
          Celebrate your gymnast&apos;s achievements with an official championship
          t-shirt featuring their name alongside all the winners.
        </p>

        <div className="flex gap-4 justify-center">
          <Link
            href="/find"
            className="bg-yellow-400 text-black px-8 py-4 rounded-lg text-lg font-bold hover:bg-yellow-300 transition"
          >
            Find Your Champion
          </Link>
          <Link
            href="/order-status"
            className="border border-white/30 px-8 py-4 rounded-lg text-lg hover:bg-white/10 transition"
          >
            Track Your Order
          </Link>
        </div>

        <div className="mt-20 grid grid-cols-1 md:grid-cols-3 gap-8 text-left">
          <div className="bg-white/5 rounded-xl p-6">
            <div className="text-3xl mb-3">1</div>
            <h3 className="font-bold mb-2">Find Your Athlete</h3>
            <p className="text-gray-400 text-sm">
              Search by state, gym, and name — or scan the QR code on your order
              form.
            </p>
          </div>
          <div className="bg-white/5 rounded-xl p-6">
            <div className="text-3xl mb-3">2</div>
            <h3 className="font-bold mb-2">Choose Your Shirt</h3>
            <p className="text-gray-400 text-sm">
              Pick your size, color, and add a jewel accent. Order for the whole
              family.
            </p>
          </div>
          <div className="bg-white/5 rounded-xl p-6">
            <div className="text-3xl mb-3">3</div>
            <h3 className="font-bold mb-2">Shipped to Your Door</h3>
            <p className="text-gray-400 text-sm">
              We screen-print and ship directly to you with tracking included.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
