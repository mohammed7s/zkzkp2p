import { notFound } from 'next/navigation';
import { getDocBySlug, getDocSlugs } from '@/lib/docs';
import { MarkdownContent } from '@/components/docs/MarkdownContent';

type Props = {
  params: Promise<{ slug: string }>;
};

export async function generateStaticParams() {
  const slugs = getDocSlugs();
  return slugs.map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: Props) {
  const { slug } = await params;
  const doc = getDocBySlug(slug);
  if (!doc) return { title: 'Not Found' };
  return { title: doc.title };
}

export default async function DocPage({ params }: Props) {
  const { slug } = await params;
  const doc = getDocBySlug(slug);

  if (!doc) {
    notFound();
  }

  return <MarkdownContent content={doc.content} />;
}
