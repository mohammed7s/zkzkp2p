'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { DocMeta } from '@/lib/docs';

type Props = {
  docs: DocMeta[];
};

export function DocsSidebar({ docs }: Props) {
  const pathname = usePathname();

  return (
    <nav>
      <p className="text-xs text-gray-600 mb-3">docs</p>
      <ul className="space-y-1">
        {docs.map((doc) => {
          const href = `/docs/${doc.slug}`;
          const isActive = pathname === href;
          return (
            <li key={doc.slug}>
              <Link
                href={href}
                className={`text-sm block py-1 ${
                  isActive
                    ? 'text-white'
                    : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                {doc.title}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
