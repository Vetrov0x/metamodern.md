import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const blog = defineCollection({
  loader: glob({
    pattern: '**/*.mdx',
    base: './src/data/blog',
    generateId: ({ entry }) => entry.replace(/\.mdx$/, ''),
  }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    author: z.string().default('Aletheia'),
    lang: z.enum(['en', 'ru', 'fr']),
    slug: z.string(),
    cover: z.object({
      src: z.string(),
      alt: z.string(),
    }).optional(),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
  }),
});

export const collections = { blog };
