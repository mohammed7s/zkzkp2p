import { notFound } from 'next/navigation';
import { getDocBySlug, getDocSlugs } from '@/lib/docs';
import { MarkdownContent } from '@/components/docs/MarkdownContent';

export async function generateStaticParams() {
  const slugs = getDocSlugs();
  return slugs.map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: { params: { slug: string } }) {
  const doc = getDocBySlug(params.slug);
  if (!doc) return { title: 'Not Found' };
  return { title: doc.title };
}

export default function DocPage({ params }: { params: { slug: string } }) {
  const doc = getDocBySlug(params.slug);

  if (!doc) {
    notFound();
  }

  return <MarkdownContent content={doc.content} />;
}
