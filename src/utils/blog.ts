import { getCollection } from 'astro:content';
import type { CollectionEntry } from 'astro:content';

export async function getBlogPostsByLang(lang: string) {
  return getCollection('blog', ({ data }) => data.lang === lang && !data.draft);
}

export async function getAlternates(slug: string, site: URL) {
  const allVersions = await getCollection('blog', ({ data }) => data.slug === slug && !data.draft);
  return allVersions.map(p => ({
    lang: p.data.lang,
    href: new URL(
      p.data.lang === 'en' ? `/blog/${p.data.slug}/` : `/${p.data.lang}/blog/${p.data.slug}/`,
      site
    ).href,
  }));
}

export function sortByDate(posts: CollectionEntry<'blog'>[]) {
  return posts.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}
