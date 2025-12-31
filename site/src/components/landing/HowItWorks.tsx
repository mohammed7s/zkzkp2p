export function HowItWorks() {
  return (
    <section className="py-16 px-4 border-t border-[#1a1a1a]">
      <div className="max-w-3xl mx-auto">
        <h2 className="text-center text-gray-500 text-sm mb-12">how it works</h2>

        {/* Flow Diagram */}
        <div className="border border-[#1a1a1a] p-8">
          <pre className="text-sm text-gray-400 overflow-x-auto">
{`  Your Funds                    Aztec                     zkp2p
      |                           |                          |
      |   ── shield ──────────>   |                          |
      |                           |                          |
      |                     [private balance]                |
      |                           |                          |
      |                           |   ── deposit ─────────>  |
      |                           |        (fresh address)   |
      |                           |                          |
                                                   [liquidity ready]`}
          </pre>
        </div>

        {/* Steps */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-8">
          <Step
            number="1"
            title="shield"
            description="Move USDC from Base to Aztec. Your balance becomes private."
          />
          <Step
            number="2"
            title="deposit"
            description="Create a zkp2p deposit from a fresh, unlinkable Base address."
          />
          <Step
            number="3"
            title="receive"
            description="Accept fiat payments. Withdraw to any address you choose."
          />
        </div>
      </div>
    </section>
  );
}

function Step({
  number,
  title,
  description,
}: {
  number: string;
  title: string;
  description: string;
}) {
  return (
    <div className="border border-[#1a1a1a] p-5">
      <div className="flex items-center gap-3 mb-2">
        <span className="text-[#A855F7] text-xs">{number}.</span>
        <span className="text-white text-sm">{title}</span>
      </div>
      <p className="text-gray-500 text-xs leading-relaxed">{description}</p>
    </div>
  );
}
