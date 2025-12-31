import Link from 'next/link';
import { Header } from '@/components/ui/Header';
import { getAllDocs } from '@/lib/docs';
import { DocsSidebar } from '@/components/docs/DocsSidebar';

export default function DocsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const docs = getAllDocs();

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <div className="flex-1 flex w-full">
        {/* Left sidebar */}
        <aside className="w-48 shrink-0 border-r border-[#1a1a1a] px-6 py-4">
          <DocsSidebar docs={docs} />
        </aside>

        {/* Content */}
        <main className="flex-1 p-8 max-w-2xl">
          {children}
        </main>
      </div>
    </div>
  );
}
