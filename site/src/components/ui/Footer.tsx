export function Footer() {
  return (
    <footer className="py-6 px-4">
      <p className="text-center text-xs text-gray-700 font-mono">
        built on{' '}
        <a
          href="https://aztec.network"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-gray-500"
        >
          aztec
        </a>
        {' + '}
        <a
          href="https://train.tech"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-gray-500"
        >
          train
        </a>
        {' + '}
        <a
          href="https://zkp2p.xyz"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-gray-500"
        >
          zkp2p
        </a>
      </p>
    </footer>
  );
}
