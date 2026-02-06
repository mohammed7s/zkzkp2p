import { getAllDocs } from '@/lib/docs';
import { DocsSidebar } from '@/components/docs/DocsSidebar';
import Link from 'next/link';

export default function DocsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const docs = getAllDocs();

  return (
    <div className="min-h-screen bg-black text-gray-300 font-mono flex flex-col">
      <header className="border-b border-gray-900 px-4 py-3">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <Link href="/" className="text-white hover:opacity-80">
            zkzkp2p
          </Link>
          <Link href="/" className="text-xs text-gray-600 hover:text-gray-400">
            back to app
          </Link>
        </div>
      </header>
      <div className="flex-1 flex w-full max-w-4xl mx-auto">
        <aside className="w-48 shrink-0 border-r border-gray-900 px-6 py-4">
          <DocsSidebar docs={docs} />
        </aside>
        <main className="flex-1 p-8 max-w-2xl">
          {children}
        </main>
      </div>
    </div>
  );
}
