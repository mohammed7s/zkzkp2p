import fs from 'fs';
import path from 'path';

const docsDirectory = path.join(process.cwd(), 'src/content/docs');

export type DocMeta = {
  slug: string;
  title: string;
  order: number;
};

// Map file names to slugs and titles
const docsMeta: Record<string, { title: string; order: number }> = {
  '01-overview.md': { title: 'Overview', order: 1 },
  '02-how-it-works.md': { title: 'How It Works', order: 2 },
  '03-deployments.md': { title: 'Deployments', order: 3 },
};

export function getDocSlugs(): string[] {
  const files = fs.readdirSync(docsDirectory);
  return files
    .filter((file) => file.endsWith('.md') && docsMeta[file])
    .map((file) => file.replace('.md', '').replace(/^\d+-/, '').replace('zkzkp2p-', ''));
}

export function getAllDocs(): DocMeta[] {
  const files = fs.readdirSync(docsDirectory);
  return files
    .filter((file) => file.endsWith('.md') && docsMeta[file])
    .map((file) => {
      const meta = docsMeta[file];
      const slug = file.replace('.md', '').replace(/^\d+-/, '').replace('zkzkp2p-', '');
      return {
        slug,
        title: meta.title,
        order: meta.order,
      };
    })
    .sort((a, b) => a.order - b.order);
}

export function getDocBySlug(slug: string): { content: string; title: string } | null {
  // Find the file that matches this slug
  const files = fs.readdirSync(docsDirectory);
  const file = files.find((f) => {
    const fileSlug = f.replace('.md', '').replace(/^\d+-/, '').replace('zkzkp2p-', '');
    return fileSlug === slug;
  });

  if (!file) return null;

  const fullPath = path.join(docsDirectory, file);
  const content = fs.readFileSync(fullPath, 'utf8');
  const meta = docsMeta[file];

  return {
    content,
    title: meta?.title || slug,
  };
}

export function getDocNavigation(slug: string): { prev: DocMeta | null; next: DocMeta | null } {
  const docs = getAllDocs();
  const index = docs.findIndex((d) => d.slug === slug);

  return {
    prev: index > 0 ? docs[index - 1] : null,
    next: index < docs.length - 1 ? docs[index + 1] : null,
  };
}
