export function Features() {
  return (
    <section className="py-16 px-4 border-t border-[#1a1a1a]">
      <div className="max-w-3xl mx-auto">
        <h2 className="text-center text-gray-500 text-sm mb-12">why zkzkp2p</h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Feature
            title="private"
            description="Aztec's encrypted state hides your transaction history. No one can link your funds to your zkp2p deposits."
          />
          <Feature
            title="trustless"
            description="Atomic swaps via Train Protocol. No custodian, no intermediary. Smart contracts enforce every step."
          />
          <Feature
            title="non-custodial"
            description="You control your keys. Timelocked refunds protect you if anything goes wrong."
          />
          <Feature
            title="permissionless"
            description="Anyone can be a solver. Open protocol with no gatekeepers."
          />
        </div>
      </div>
    </section>
  );
}

function Feature({ title, description }: { title: string; description: string }) {
  return (
    <div className="border border-[#1a1a1a] p-5">
      <h3 className="text-white text-sm mb-2">{title}</h3>
      <p className="text-gray-500 text-xs leading-relaxed">{description}</p>
    </div>
  );
}
