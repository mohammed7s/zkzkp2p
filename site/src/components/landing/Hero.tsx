import Link from 'next/link';
import Image from 'next/image';

export function Hero() {
  return (
    <section className="py-24 px-4 w-full">
      <div className="max-w-md mx-auto text-center space-y-6">
        {/* Wordmark - the logo */}
        <div className="flex justify-center">
          <Image
            src="/logos/wordmark.svg"
            alt="zkzkp2p"
            width={280}
            height={44}
            priority
            className="h-10 w-auto"
          />
        </div>

        {/* Tagline */}
        <p className="text-gray-400">
          the privacy layer for{' '}
          <a
            href="https://zkp2p.xyz"
            target="_blank"
            rel="noopener noreferrer"
            className="text-white hover:underline"
          >
            zkp2p
          </a>
        </p>

        {/* CTA - login button */}
        <div className="pt-6">
          <Link
            href="/app"
            className="inline-block px-16 py-4 bg-white text-black text-lg rounded-full hover:bg-gray-200"
          >
            login
          </Link>
        </div>

        {/* How it works link */}
        <p className="pt-8">
          <Link
            href="/docs/how-it-works"
            className="text-sm text-gray-600 hover:text-gray-400 font-mono"
          >
            [how it works]
          </Link>
        </p>
      </div>
    </section>
  );
}
