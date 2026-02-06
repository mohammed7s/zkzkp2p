export function ArchitectureDiagram() {
  return (
    <svg width="520" height="400" viewBox="0 0 420 320" className="my-6">
      <defs>
        <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
          <path d="M0,0 L8,4 L0,8 Z" fill="#A855F7"/>
        </marker>
        <marker id="arrow-start" markerWidth="8" markerHeight="8" refX="2" refY="4" orient="auto">
          <path d="M8,0 L0,4 L8,8 Z" fill="#A855F7"/>
        </marker>
        <marker id="arrow-gray" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
          <path d="M0,0 L8,4 L0,8 Z" fill="#666"/>
        </marker>
      </defs>

      {/* AZTEC Layer */}
      <rect x="20" y="20" width="380" height="100" rx="4" fill="#0a0a0a" stroke="#333" strokeWidth="1"/>
      <text x="35" y="45" fill="#fff" fontFamily="system-ui, sans-serif" fontSize="13" fontWeight="600">AZTEC</text>
      <text x="90" y="45" fill="#666" fontFamily="system-ui, sans-serif" fontSize="10">encrypted</text>

      {/* Private Balance */}
      <rect x="35" y="65" width="140" height="40" rx="3" fill="#111" stroke="#333" strokeWidth="1"/>
      <text x="105" y="90" fill="#ccc" fontFamily="monospace" fontSize="11" textAnchor="middle">Private Balance</text>

      {/* Substance on Aztec */}
      <rect x="245" y="65" width="135" height="40" rx="3" fill="#111" stroke="#A855F7" strokeWidth="1"/>
      <text x="312" y="90" fill="#A855F7" fontFamily="monospace" fontSize="11" textAnchor="middle">Substance Order</text>

      {/* Arrow from balance to substance */}
      <line x1="175" y1="85" x2="240" y2="85" stroke="#666" strokeWidth="1.5" markerEnd="url(#arrow-gray)"/>

      {/* BASE Layer */}
      <rect x="20" y="140" width="380" height="160" rx="4" fill="#0a0a0a" stroke="#333" strokeWidth="1"/>
      <text x="35" y="165" fill="#fff" fontFamily="system-ui, sans-serif" fontSize="13" fontWeight="600">BASE</text>
      <text x="75" y="165" fill="#666" fontFamily="system-ui, sans-serif" fontSize="10">public</text>

      {/* Fresh Address */}
      <rect x="35" y="190" width="140" height="40" rx="3" fill="#111" stroke="#333" strokeWidth="1"/>
      <text x="105" y="215" fill="#ccc" fontFamily="monospace" fontSize="11" textAnchor="middle">Burner Address</text>

      {/* Substance on Base */}
      <rect x="245" y="190" width="135" height="40" rx="3" fill="#111" stroke="#A855F7" strokeWidth="1"/>
      <text x="312" y="215" fill="#A855F7" fontFamily="monospace" fontSize="11" textAnchor="middle">Substance Order</text>

      {/* Arrow from substance to fresh */}
      <line x1="240" y1="210" x2="175" y2="210" stroke="#666" strokeWidth="1.5" markerEnd="url(#arrow-gray)"/>

      {/* zkp2p inside BASE */}
      <rect x="35" y="250" width="120" height="35" rx="3" fill="#111" stroke="#4ADE80" strokeWidth="1"/>
      <text x="95" y="273" fill="#4ADE80" fontFamily="monospace" fontSize="12" textAnchor="middle">zkp2p</text>

      {/* Arrow to zkp2p */}
      <line x1="105" y1="230" x2="105" y2="245" stroke="#666" strokeWidth="1.5" markerEnd="url(#arrow-gray)"/>

      {/* Double arrow between Substance orders with solver label */}
      <line x1="312" y1="110" x2="312" y2="185" stroke="#A855F7" strokeWidth="2" markerStart="url(#arrow-start)" markerEnd="url(#arrow)"/>
      <text x="335" y="150" fill="#A855F7" fontFamily="system-ui, sans-serif" fontSize="10">solvers</text>

      {/* Dashed border around Substance section */}
      <rect x="235" y="55" width="155" height="190" rx="6" fill="none" stroke="#A855F7" strokeWidth="1.5" strokeDasharray="6,4"/>
      <text x="312" y="260" fill="#A855F7" fontFamily="system-ui, sans-serif" fontSize="10" textAnchor="middle" opacity="0.8">Substance Bridge</text>
    </svg>
  );
}
