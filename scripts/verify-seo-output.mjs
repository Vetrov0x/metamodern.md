#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const SITE = 'https://metamodern.md';
const SITE_URL = new URL(SITE);
const ARCHETYPES_ROUTE = '/ru/12-archetypes/';
const ARCHETYPES_MODES = new Set(['pending', 'promote', 'noindex', 'remove']);
const DIAGNOSTIC_LIMIT = 8;
const REDACTED_SEGMENT = '<redacted>';
const CREDENTIAL_SEGMENT_RE = /(?:^|[^a-z0-9])(?:secret|token|credential|credentials|password|passwd|pwd|api[-_]?key|access[-_]?token|refresh[-_]?token|private[-_]?key|client[-_]?secret|session[-_]?key|auth[-_]?key|key)(?:[^a-z0-9]|$)/i;
const BASE_EXPECTED_SITEMAP_ROUTES = new Set([
  '/',
  '/blog/',
  '/blog/firstproof-ai-math/',
  '/blog/verification-paradox/',
  '/blog/why-im-not-openclaw/',
  '/fr/blog/',
  '/fr/blog/verification-paradox/',
  '/fr/blog/why-im-not-openclaw/',
  '/ru/blog/',
  '/ru/blog/verification-paradox/',
  '/ru/blog/why-im-not-openclaw/',
]);
const BASE_EXPECTED_NOINDEX_ROUTES = new Set(['/404.html']);
const { rootArg, archetypesMode, buildStartArg } = parseArgs(process.argv.slice(2));
const EXPECTED_SITEMAP_URLS = BASE_EXPECTED_SITEMAP_ROUTES.size + (archetypesMode === 'promote' ? 1 : 0);
const EXPECTED_NOINDEX_HTML = BASE_EXPECTED_NOINDEX_ROUTES.size + (archetypesMode === 'noindex' ? 1 : 0);
const EXPECTED_ARCHETYPES_HTML = archetypesMode === 'remove' ? 0 : 1;
const EXPECTED_KNOWN_ORPHAN_HTML = archetypesMode === 'pending' ? 1 : 0;
const EXPECTED_CURRENT_HTML = BASE_EXPECTED_SITEMAP_ROUTES.size + BASE_EXPECTED_NOINDEX_ROUTES.size + EXPECTED_ARCHETYPES_HTML;
const EXPECTED_COUNT_SUMMARY = `${EXPECTED_SITEMAP_URLS} sitemap + ${EXPECTED_NOINDEX_HTML} noindex + ${EXPECTED_KNOWN_ORPHAN_HTML} pending known orphan; archetypes-mode=${archetypesMode}`;
const KNOWN_ORPHAN_ROUTES = archetypesMode === 'pending' ? new Set([ARCHETYPES_ROUTE]) : new Set();
const root = path.resolve(process.cwd(), rootArg);
const displayRoot = path.relative(process.cwd(), root) || '.';
const IDENTITY_CORE_URL_FIELDS = ['url', 'sameAs', 'mainEntityOfPage', 'isPartOf', 'publisher', 'about'];
const sitemapBuildReferences = buildSitemapBuildReferences(buildStartArg, process.env.SOURCE_DATE_EPOCH);

const failures = [];

function controlledCliError(code, message) {
  console.error(`FAIL ${code}: ${message}`);
  process.exit(1);
}

function parseArgs(args) {
  let parsedRootArg = 'dist';
  let rootSeen = false;
  let parsedArchetypesMode = 'pending';
  let parsedBuildStartArg = '';

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--archetypes-mode') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) controlledCliError('cli.archetypes-mode', '--archetypes-mode requires one of: pending, promote, noindex, remove');
      parsedArchetypesMode = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--archetypes-mode=')) {
      parsedArchetypesMode = arg.slice('--archetypes-mode='.length);
      continue;
    }
    if (arg === '--build-start') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) controlledCliError('cli.build-start', '--build-start requires a truthful ISO date or datetime');
      parsedBuildStartArg = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--build-start=')) {
      parsedBuildStartArg = arg.slice('--build-start='.length);
      if (!parsedBuildStartArg) controlledCliError('cli.build-start', '--build-start requires a truthful ISO date or datetime');
      continue;
    }
    if (arg.startsWith('--')) controlledCliError('cli.argument', `unknown option: ${arg}`);
    if (rootSeen) controlledCliError('cli.argument', `unexpected extra argument: ${arg}`);
    parsedRootArg = arg;
    rootSeen = true;
  }

  if (!ARCHETYPES_MODES.has(parsedArchetypesMode)) {
    controlledCliError('cli.archetypes-mode', `invalid --archetypes-mode "${parsedArchetypesMode}"; expected one of: pending, promote, noindex, remove`);
  }
  if (parsedBuildStartArg && !parseExplicitBuildStartDateKey(parsedBuildStartArg)) {
    controlledCliError('cli.build-start', '--build-start must be a truthful ISO date or datetime');
  }

  return { rootArg: parsedRootArg, archetypesMode: parsedArchetypesMode, buildStartArg: parsedBuildStartArg };
}

function fail(code, message, routes = []) {
  failures.push({ code, message, routes: [...routes].sort(routeSort) });
}

function suspiciousDiagnosticSegment(segment) {
  const core = String(segment).replace(/^[^A-Za-z0-9+/_=-]+|[^A-Za-z0-9+/_=-]+$/g, '');
  if (!core) return false;
  const withoutExtension = core.replace(/\.[a-z0-9]{1,8}$/i, '');
  if (CREDENTIAL_SEGMENT_RE.test(core)) return true;
  if (/^[a-f0-9]{24,}$/i.test(withoutExtension)) return true;
  return /^(?=.{32,}$)(?=.*[A-Z0-9+/_=-])[A-Za-z0-9+/_=-]+={0,2}$/.test(withoutExtension);
}

function sanitizeDiagnosticValue(value) {
  return String(value)
    .split(/([/\s?#&;]+)/)
    .map(part => {
      if (!part || /^[/\s?#&;]+$/.test(part)) return part;
      if (!suspiciousDiagnosticSegment(part)) return part;
      return part.replace(/[^A-Za-z0-9+/_=-]*[A-Za-z0-9+/_=-]+[^A-Za-z0-9+/_=-]*/, REDACTED_SEGMENT);
    })
    .join('');
}

function formatDiagnosticRoutes(routes) {
  const visible = routes.slice(0, DIAGNOSTIC_LIMIT).map(sanitizeDiagnosticValue);
  const remaining = routes.length - visible.length;
  if (remaining > 0) visible.push(`+${remaining} more`);
  return visible.join('; ');
}

function routeSort(a, b) {
  return String(a).localeCompare(String(b), 'en', { numeric: true });
}

function parseExplicitBuildStartDateKey(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(trimmed)) return null;
  if (parseTruthfulDate(trimmed) === null) return null;
  return trimmed.slice(0, 10);
}

function parseSourceDateEpochDateKey(value) {
  if (!value || !String(value).trim()) return null;
  const trimmed = String(value).trim();
  if (!/^\d+$/.test(trimmed)) {
    controlledCliError('env.source-date-epoch', 'SOURCE_DATE_EPOCH must be an integer Unix timestamp in seconds');
  }
  const seconds = Number(trimmed);
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 8640000000000) {
    controlledCliError('env.source-date-epoch', 'SOURCE_DATE_EPOCH must be a safe non-negative Unix timestamp in seconds');
  }
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function buildSitemapBuildReferences(explicitBuildStart, sourceDateEpoch) {
  const references = [];
  const buildStartDateKey = parseExplicitBuildStartDateKey(explicitBuildStart);
  if (buildStartDateKey) references.push({ source: '--build-start', dateKey: buildStartDateKey });
  const sourceDateEpochDateKey = parseSourceDateEpochDateKey(sourceDateEpoch);
  if (sourceDateEpochDateKey) references.push({ source: 'SOURCE_DATE_EPOCH', dateKey: sourceDateEpochDateKey });
  return references;
}

function pathInsideRoot(candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function decodeUrlPathname(pathname) {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

function resolveDecodedPathnameInsideRoot(decodedPathname) {
  const rel = decodedPathname.replace(/^\/+/, '');
  const candidate = path.resolve(root, rel);
  return pathInsideRoot(candidate) ? candidate : null;
}

function readText(file) {
  return readFileSync(file, 'utf8');
}

function readBinary(file) {
  return readFileSync(file);
}

function walkHtml(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) walkHtml(fullPath, acc);
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) acc.push(fullPath);
  }
  return acc;
}

function posixRelative(file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function routeFromFile(file) {
  const rel = posixRelative(file);
  if (rel === 'index.html') return '/';
  if (rel === '404.html') return '/404.html';
  if (rel.endsWith('/index.html')) return `/${rel.slice(0, -'index.html'.length)}`;
  return `/${rel}`;
}

function routeToPathname(route) {
  if (route === '/') return '/';
  return route.startsWith('/') ? route : `/${route}`;
}

function urlForRoute(route) {
  return `${SITE}${routeToPathname(route)}`;
}

function routeFromPathname(pathname) {
  if (pathname === '/') return '/';
  if (pathname === '/404.html') return '/404.html';
  if (pathname.endsWith('/')) return pathname;
  return pathname;
}

function safeUrl(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function resolveHrefToSiteUrl(href, base = SITE) {
  if (!href || typeof href !== 'string') return null;
  try {
    const parsed = new URL(href, base);
    if (parsed.origin !== SITE_URL.origin) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function fileFromSiteUrl(url) {
  const parsed = typeof url === 'string' ? safeUrl(url) : url;
  if (!parsed || parsed.origin !== SITE_URL.origin) return null;
  let pathname = decodeUrlPathname(parsed.pathname);
  if (pathname === null) return null;
  if (pathname === '/') pathname = '/index.html';
  else if (pathname.endsWith('/')) pathname += 'index.html';
  return resolveDecodedPathnameInsideRoot(pathname);
}

function assetFromSiteUrl(url) {
  const parsed = typeof url === 'string' ? safeUrl(url) : url;
  if (!parsed || parsed.origin !== SITE_URL.origin) return null;
  const pathname = decodeUrlPathname(parsed.pathname);
  if (pathname === null) return null;
  return resolveDecodedPathnameInsideRoot(pathname);
}

function attrMap(tag) {
  const body = tag
    .replace(/^<\s*\/?\s*[\w:-]+\s*/i, '')
    .replace(/\/?\s*>$/i, '');
  const attrs = new Map();
  const re = /([:@A-Za-z0-9_-]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
  let match;
  while ((match = re.exec(body))) {
    let value = match[2] ?? '';
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    attrs.set(match[1].toLowerCase(), decodeEntities(value));
  }
  return attrs;
}

function tags(html, name) {
  const re = new RegExp(`<${name}\\b[^>]*>`, 'gi');
  return [...html.matchAll(re)].map(match => attrMap(match[0]));
}

function linksByRel(info, rel) {
  return info.links.filter(attrs => (attrs.get('rel') ?? '').toLowerCase().split(/\s+/).includes(rel));
}

function metasBy(info, key, value) {
  return info.metas
    .filter(attrs => (attrs.get(key) ?? '').toLowerCase() === value.toLowerCase())
    .map(attrs => attrs.get('content') ?? '');
}

function firstMeta(info, key, value) {
  return metasBy(info, key, value)[0];
}

function textOfFirst(html, tagName) {
  const re = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = html.match(re);
  return match ? cleanText(match[1]) : '';
}

function textOfAll(html, tagName) {
  const re = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
  return [...html.matchAll(re)].map(match => cleanText(match[1]));
}

function cleanText(value) {
  return decodeEntities(String(value).replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
}

function decodeEntities(value) {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)));
}

function ldJsonBlocks(html) {
  const blocks = [];
  const re = /<script\b[^>]*>[\s\S]*?<\/script>/gi;
  for (const match of html.matchAll(re)) {
    const open = match[0].match(/^<script\b[^>]*>/i)?.[0] ?? '';
    const attrs = attrMap(open);
    if ((attrs.get('type') ?? '').toLowerCase() !== 'application/ld+json') continue;
    const body = match[0]
      .replace(/^<script\b[^>]*>/i, '')
      .replace(/<\/script>$/i, '')
      .trim();
    blocks.push(body);
  }
  return blocks;
}

function flattenSchema(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) flattenSchema(item, out);
    return out;
  }
  out.push(node);
  if (Array.isArray(node['@graph'])) flattenSchema(node['@graph'], out);
  return out;
}

function schemaTypeList(node) {
  const type = node?.['@type'];
  if (!type) return [];
  return (Array.isArray(type) ? type : [type]).filter(item => typeof item === 'string');
}

function nodeHasType(node, type) {
  return schemaTypeList(node).includes(type);
}

function schemaTypes(schemas) {
  return new Set(schemas.flatMap(schema => flattenSchema(schema).flatMap(schemaTypeList)));
}

function normalizeIdentityUrl(value) {
  if (!value || typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    return new URL(trimmed, SITE).href;
  } catch {
    return trimmed;
  }
}

function identityUrlValues(value) {
  if (!value) return [];
  if (typeof value === 'string') {
    const normalized = normalizeIdentityUrl(value);
    return normalized ? [normalized] : [];
  }
  if (Array.isArray(value)) return value.flatMap(identityUrlValues);
  if (typeof value === 'object') return [value['@id'], value.url].flatMap(identityUrlValues);
  return [];
}

function identityCoreUrlMap(node) {
  const out = new Map();
  for (const field of IDENTITY_CORE_URL_FIELDS) {
    const values = [...new Set(identityUrlValues(node?.[field]))].sort(routeSort);
    if (values.length) out.set(field, values);
  }
  return out;
}

function sameArrayValues(a, b) {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function routesForOccurrences(occurrences) {
  return [...new Set(occurrences.map(item => item.route))].sort(routeSort);
}

function buildGlobalIdGraph(infos) {
  const idMap = new Map();
  const conflicts = [];

  function addConflict(kind, id, detail, occurrences) {
    const routes = routesForOccurrences(occurrences);
    conflicts.push(`${kind} ${id} ${detail} routes ${routes.join(', ')}`);
  }

  for (const info of infos) {
    for (const node of info.schemas.flatMap(schema => flattenSchema(schema))) {
      const id = node?.['@id'];
      if (!id || typeof id !== 'string') continue;
      const typeKey = schemaTypeList(node).sort(routeSort).join('|');
      const coreUrls = identityCoreUrlMap(node);
      const occurrence = { route: info.route, node, typeKey, coreUrls };
      const existing = idMap.get(id);
      if (existing) {
        if (existing.typeKey && typeKey && existing.typeKey !== typeKey) {
          addConflict('@type', id, `${existing.typeKey} != ${typeKey}`, [...existing.occurrences, occurrence]);
        }
        for (const [field, values] of coreUrls) {
          const existingValues = existing.coreUrls.get(field);
          if (existingValues && !sameArrayValues(existingValues, values)) {
            addConflict(field, id, `${existingValues.join('|')} != ${values.join('|')}`, [...existing.occurrences, occurrence]);
          }
        }
        existing.occurrences.push(occurrence);
        if (!existing.typeKey && typeKey) existing.typeKey = typeKey;
        for (const [field, values] of coreUrls) {
          if (!existing.coreUrls.has(field)) existing.coreUrls.set(field, values);
        }
      } else {
        idMap.set(id, { occurrences: [occurrence], typeKey, coreUrls });
      }
    }
  }
  return { idMap, conflicts: [...new Set(conflicts)].sort(routeSort) };
}

function expectedLang(route) {
  if (route.startsWith('/ru/')) return 'ru';
  if (route.startsWith('/fr/')) return 'fr';
  return 'en';
}

function langPrefix(route) {
  const lang = expectedLang(route);
  return lang === 'en' ? '' : `/${lang}`;
}

function articleSlug(route) {
  const match = route.match(/^\/(?:((?:ru|fr))\/)?blog\/([^/]+)\/$/);
  if (!match) return null;
  return match[2];
}

function isArticleRoute(route) {
  return articleSlug(route) !== null;
}

function blogIndexLang(route) {
  if (route === '/blog/') return 'en';
  const match = route.match(/^\/(ru|fr)\/blog\/$/);
  return match?.[1] ?? null;
}

function equivalenceKey(route) {
  if (route === '/') return 'home';
  const blogLang = blogIndexLang(route);
  if (blogLang) return 'blog-index';
  const slug = articleSlug(route);
  if (slug) return `article:${slug}`;
  return null;
}

function xmlTagValue(body, tagName) {
  const re = new RegExp(`<${tagName}\\b[^>]*>\\s*([\\s\\S]*?)\\s*<\\/${tagName}>`, 'i');
  const match = body.match(re);
  return match ? decodeEntities(match[1].trim()) : '';
}

function parseSitemapIndex(file) {
  if (!existsSync(file)) return null;
  const xml = readText(file);
  const entries = [...xml.matchAll(/<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi)].map(match => ({ loc: xmlTagValue(match[1], 'loc') }));
  if (entries.length) return entries;
  return [...xml.matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi)].map(match => ({ loc: decodeEntities(match[1].trim()) }));
}

function parseSitemapEntries(file) {
  if (!existsSync(file)) return null;
  const xml = readText(file);
  const blocks = [...xml.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gi)].map(match => match[1]);
  if (!blocks.length) {
    return [...xml.matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi)].map(match => ({ loc: decodeEntities(match[1].trim()), lastmod: '' }));
  }
  return blocks.map(block => ({ loc: xmlTagValue(block, 'loc'), lastmod: xmlTagValue(block, 'lastmod') }));
}

function isValidCalendarDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

function parseTruthfulDate(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) return null;
  const datePrefix = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/);
  if (datePrefix && !isValidCalendarDate(Number(datePrefix[1]), Number(datePrefix[2]), Number(datePrefix[3]))) return null;
  return timestamp;
}

function parseSitemapLastmod(value) {
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(trimmed)) return null;
  return parseTruthfulDate(trimmed);
}

function dateKey(value) {
  return value.trim().slice(0, 10);
}

function sameInstant(a, b) {
  const parsedA = parseTruthfulDate(a);
  const parsedB = parseTruthfulDate(b);
  return parsedA !== null && parsedB !== null && parsedA === parsedB;
}

function getIdReference(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof value['@id'] === 'string') return value['@id'];
  return '';
}

function normalizeVisibleText(value) {
  return cleanText(value).toLowerCase();
}

function anchorTags(fragment) {
  const out = [];
  const re = /<a\b[^>]*>[\s\S]*?<\/a>/gi;
  for (const match of fragment.matchAll(re)) {
    const open = match[0].match(/^<a\b[^>]*>/i)?.[0] ?? '';
    out.push({ attrs: attrMap(open), text: cleanText(match[0]) });
  }
  return out;
}

function visibleBreadcrumbContainers(html) {
  const containers = [];
  const re = /<(nav|ol|ul)\b[^>]*(?:aria-label\s*=\s*(?:"[^"]*breadcrumb[^"]*"|'[^']*breadcrumb[^']*'|[^\s>]*breadcrumb[^\s>]*)|class\s*=\s*(?:"[^"]*breadcrumb[^"]*"|'[^']*breadcrumb[^']*'|[^\s>]*breadcrumb[^\s>]*))[^>]*>[\s\S]*?<\/\1>/gi;
  for (const match of html.matchAll(re)) containers.push(match[0]);
  return containers;
}

function validateVisibleArticleBreadcrumb(info, expectedUrls) {
  const containers = visibleBreadcrumbContainers(info.html);
  if (!containers.length) return 'missing visible breadcrumb container';
  for (const container of containers) {
    const anchors = anchorTags(container).map(anchor => ({
      text: normalizeVisibleText(anchor.text),
      href: resolveHrefToSiteUrl(anchor.attrs.get('href') ?? '', info.url),
    }));
    const containerText = normalizeVisibleText(container);
    const h1 = normalizeVisibleText(info.h1s[0] ?? '');
    const hasHome = anchors[0]?.text === 'home' && anchors[0]?.href === expectedUrls[0];
    const hasBlog = anchors[1]?.text === 'blog' && anchors[1]?.href === expectedUrls[1];
    const linkedArticle = anchors[2]?.href === expectedUrls[2] && anchors[2]?.text === h1;
    const currentArticle = h1 && containerText.includes(h1);
    if (hasHome && hasBlog && (linkedArticle || currentArticle)) return '';
  }
  return 'visible breadcrumb must be Home → Blog → Article with canonical URLs';
}

function extractBreadcrumbUrls(node) {
  const items = Array.isArray(node?.itemListElement) ? node.itemListElement : [];
  return items
    .map((entry, index) => {
      const position = Number(entry?.position ?? index + 1);
      const item = entry?.item;
      const url = typeof item === 'string' ? item : (item?.['@id'] ?? item?.url ?? '');
      return { position, url: resolveHrefToSiteUrl(url, SITE) };
    })
    .sort((a, b) => a.position - b.position)
    .map(item => item.url ?? '');
}

function pngDimensions(buffer) {
  if (buffer.length < 24) return null;
  if (buffer.toString('ascii', 1, 4) !== 'PNG') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), type: 'png' };
}

function jpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3), type: 'jpeg' };
    }
    offset += length;
  }
  return null;
}

function readUInt24LE(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function webpDimensions(buffer) {
  if (buffer.length < 30 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = buffer.toString('ascii', 12, 16);
  if (chunk === 'VP8X' && buffer.length >= 30) {
    return { width: readUInt24LE(buffer, 24) + 1, height: readUInt24LE(buffer, 27) + 1, type: 'webp' };
  }
  if (chunk === 'VP8L' && buffer.length >= 25 && buffer[20] === 0x2f) {
    const b0 = buffer[21];
    const b1 = buffer[22];
    const b2 = buffer[23];
    const b3 = buffer[24];
    return { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)), type: 'webp' };
  }
  if (chunk === 'VP8 ' && buffer.length >= 30 && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff, type: 'webp' };
  }
  return null;
}

function imageDimensions(file) {
  const buffer = readBinary(file);
  return pngDimensions(buffer) ?? jpegDimensions(buffer) ?? webpDimensions(buffer);
}

function parseFeedItems(file) {
  if (!existsSync(file)) return null;
  const xml = readText(file);
  const channelLanguage = xmlTagValue(xml, 'language');
  const items = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map(match => ({
    title: xmlTagValue(match[1], 'title'),
    link: xmlTagValue(match[1], 'link'),
    guid: xmlTagValue(match[1], 'guid'),
    pubDate: xmlTagValue(match[1], 'pubDate'),
  }));
  return { channelLanguage, items };
}

if (!existsSync(root) || !statSync(root).isDirectory()) {
  console.error(`FAIL root.missing: output root not found: ${sanitizeDiagnosticValue(displayRoot)}`);
  process.exit(1);
}

const htmlFiles = walkHtml(root).sort((a, b) => routeSort(routeFromFile(a), routeFromFile(b)));
const infos = htmlFiles.map(file => {
  const html = readText(file);
  const route = routeFromFile(file);
  const htmlTag = html.match(/<html\b[^>]*>/i)?.[0] ?? '';
  const parsedSchemas = [];
  const jsonErrors = [];
  for (const block of ldJsonBlocks(html)) {
    try {
      parsedSchemas.push(JSON.parse(block));
    } catch (error) {
      jsonErrors.push(error.message);
    }
  }
  return {
    file,
    route,
    url: urlForRoute(route),
    html,
    lang: attrMap(htmlTag).get('lang') ?? '',
    title: textOfFirst(html, 'title'),
    h1s: textOfAll(html, 'h1'),
    metas: tags(html, 'meta'),
    links: tags(html, 'link'),
    anchors: tags(html, 'a'),
    images: tags(html, 'img'),
    schemas: parsedSchemas,
    schemaTypes: schemaTypes(parsedSchemas),
    jsonErrors,
  };
});

const byRoute = new Map(infos.map(info => [info.route, info]));
const byUrl = new Map(infos.map(info => [info.url, info]));
const globalIdGraph = buildGlobalIdGraph(infos);

const sitemapIndexEntries = parseSitemapIndex(path.join(root, 'sitemap-index.xml'));
const sitemapEntries = parseSitemapEntries(path.join(root, 'sitemap-0.xml'));

if (!sitemapIndexEntries) fail('sitemap.index.missing', 'missing sitemap-index.xml');
if (!sitemapEntries) fail('sitemap.urls.missing', 'missing sitemap-0.xml');

const sitemapIndexLocs = [];
for (const entry of sitemapIndexEntries ?? []) {
  const parsed = safeUrl(entry.loc);
  if (!parsed) {
    fail('sitemap.index.url.malformed', 'sitemap-index.xml contains malformed loc', [entry.loc || '<empty>']);
    continue;
  }
  sitemapIndexLocs.push(parsed.href);
  if (parsed.origin !== SITE_URL.origin) fail('sitemap.index.host', `sitemap index URL is outside ${SITE}`, [parsed.href]);
}

const sitemapUrls = new Set();
const sitemapLastmods = [];
for (const entry of sitemapEntries ?? []) {
  const parsed = safeUrl(entry.loc);
  if (!parsed) {
    fail('sitemap.url.malformed', 'sitemap-0.xml contains malformed loc', [entry.loc || '<empty>']);
    continue;
  }
  if (parsed.origin !== SITE_URL.origin) fail('sitemap.host', `sitemap URL is outside ${SITE}`, [parsed.href]);
  sitemapUrls.add(parsed.href);

  if (entry.lastmod) {
    const parsedLastmod = parseSitemapLastmod(entry.lastmod);
    if (parsedLastmod === null) fail('sitemap.lastmod.unsupported', 'sitemap lastmod must be a truthful ISO date or datetime', [parsed.pathname]);
    else sitemapLastmods.push(entry.lastmod.trim());
  }
}

const sitemapInfos = [...sitemapUrls].map(url => byUrl.get(url)).filter(Boolean);
const noindexInfos = infos.filter(info => metasBy(info, 'name', 'robots').some(value => /(?:^|,)\s*noindex\b/i.test(value)));
const noindexRoutes = new Set(noindexInfos.map(info => info.route));
const knownOrphanInfos = infos.filter(info => KNOWN_ORPHAN_ROUTES.has(info.route) && !sitemapUrls.has(info.url) && !noindexRoutes.has(info.route));
const knownOrphanRoutes = new Set(knownOrphanInfos.map(info => info.route));
const classifiedRoutes = new Set([...sitemapInfos.map(info => info.route), ...noindexInfos.map(info => info.route), ...knownOrphanInfos.map(info => info.route)]);
const unknownIndexable = infos.filter(info => !sitemapUrls.has(info.url) && !noindexRoutes.has(info.route) && !knownOrphanRoutes.has(info.route));

if (sitemapIndexEntries && sitemapIndexLocs.length !== 1) {
  fail('sitemap.index.count', `expected 1 sitemap in sitemap-index.xml, found ${sitemapIndexLocs.length}`);
}
if (sitemapIndexLocs.length === 1 && sitemapIndexLocs[0] !== `${SITE}/sitemap-0.xml`) {
  fail('sitemap.index.target', 'sitemap-index.xml must point to sitemap-0.xml', sitemapIndexLocs);
}
if (sitemapEntries && sitemapUrls.size !== EXPECTED_SITEMAP_URLS) {
  fail('sitemap.url.count', `expected ${EXPECTED_SITEMAP_URLS} unique sitemap URLs, found ${sitemapUrls.size}`);
}
if (noindexInfos.length !== EXPECTED_NOINDEX_HTML) {
  fail('html.noindex.count', `expected ${EXPECTED_NOINDEX_HTML} noindex HTML file, found ${noindexInfos.length}`, noindexInfos.map(info => info.route));
}
if (infos.length !== EXPECTED_CURRENT_HTML) {
  fail('html.total.count', `expected current classification total ${EXPECTED_CURRENT_HTML} HTML files (${EXPECTED_COUNT_SUMMARY}), found ${infos.length}`, infos.map(info => info.route));
}
if (classifiedRoutes.size !== EXPECTED_CURRENT_HTML) {
  fail('html.classified.count', `expected ${EXPECTED_CURRENT_HTML} classified HTML files (${EXPECTED_COUNT_SUMMARY}), classified ${classifiedRoutes.size}`);
}
if (knownOrphanInfos.length) {
  fail('html.known-orphan', 'known generated orphan is neither in sitemap nor noindex; keep as dedicated output failure', knownOrphanInfos.map(info => info.route));
}
if (unknownIndexable.length) {
  fail('html.unclassified-indexable', `${unknownIndexable.length} HTML file(s) are neither in sitemap nor noindex nor the known orphan set`, unknownIndexable.map(info => info.route));
}

for (const url of sitemapUrls) {
  const parsed = safeUrl(url);
  if (!parsed) continue;
  const expectedFile = fileFromSiteUrl(parsed);
  if (!expectedFile || !existsSync(expectedFile)) fail('sitemap.file.missing', 'sitemap URL has no matching HTML file', [parsed.pathname]);
}

if (sitemapLastmods.length) {
  if (sitemapBuildReferences.length) {
    const referenceDateKeys = new Set(sitemapBuildReferences.map(reference => reference.dateKey));
    const buildStamped = sitemapLastmods.filter(lastmod => referenceDateKeys.has(dateKey(lastmod)));
    if (buildStamped.length) {
      const referenceLabels = sitemapBuildReferences
        .map(reference => `${reference.source}=${reference.dateKey}`)
        .sort(routeSort)
        .join(', ');
      fail('sitemap.lastmod.build-start', `sitemap lastmod must not be stamped with explicit build reference date(s): ${referenceLabels}`, buildStamped);
    }
  }
  const uniqueDates = new Set(sitemapLastmods.map(dateKey));
  if (sitemapLastmods.length > 3 && uniqueDates.size === 1) fail('sitemap.lastmod.stamped', 'sitemap lastmod values look build-stamped instead of content-derived', [...uniqueDates]);
}

if (!byRoute.get('/404.html')) fail('html.404.missing', 'missing generated 404.html');
else if (!noindexRoutes.has('/404.html')) fail('html.404.noindex', '404.html must be noindex', ['/404.html']);

const archetypesInfo = byRoute.get(ARCHETYPES_ROUTE);
const archetypesUrl = urlForRoute(ARCHETYPES_ROUTE);
const archetypesInSitemap = sitemapUrls.has(archetypesUrl);
const archetypesIsNoindex = noindexRoutes.has(ARCHETYPES_ROUTE);

if (archetypesMode === 'pending') {
  if (!archetypesInfo) {
    fail('html.archetypes.pending', 'pending archetypes page must exist as indexable output outside sitemap', [ARCHETYPES_ROUTE]);
  } else {
    if (archetypesIsNoindex) fail('html.archetypes.pending', 'pending archetypes page must remain indexable (not noindex)', [ARCHETYPES_ROUTE]);
    if (archetypesInSitemap) fail('html.archetypes.pending', 'pending archetypes page must remain outside sitemap until promotion is approved', [ARCHETYPES_ROUTE]);
  }
}

if (archetypesMode === 'promote') {
  if (!archetypesInfo) {
    fail('html.archetypes.promote', 'promoted archetypes page must exist, be indexable, use one self canonical, and be listed in sitemap', [ARCHETYPES_ROUTE]);
  } else {
    const canonical = linksByRel(archetypesInfo, 'canonical').map(attrs => attrs.get('href') ?? '');
    if (archetypesIsNoindex) fail('html.archetypes.promote', 'promoted archetypes page must be indexable (not noindex)', [ARCHETYPES_ROUTE]);
    if (!archetypesInSitemap) fail('html.archetypes.promote', 'promoted archetypes page must be listed in sitemap', [ARCHETYPES_ROUTE]);
    if (canonical.length !== 1 || canonical[0] !== archetypesUrl) fail('html.archetypes.promote', 'promoted archetypes page must have exactly one self canonical', [ARCHETYPES_ROUTE]);
  }
}

if (archetypesMode === 'noindex') {
  if (!archetypesInfo) {
    fail('html.archetypes.noindex', 'noindex archetypes page must exist, have noindex, and be absent from sitemap', [ARCHETYPES_ROUTE]);
  } else {
    if (!archetypesIsNoindex) fail('html.archetypes.noindex', 'noindex archetypes page must have a robots noindex meta tag', [ARCHETYPES_ROUTE]);
    if (archetypesInSitemap) fail('html.archetypes.noindex', 'noindex archetypes page must be absent from sitemap', [ARCHETYPES_ROUTE]);
  }
}

if (archetypesMode === 'remove') {
  if (archetypesInfo) fail('html.archetypes.remove', 'removed archetypes page must be absent from generated HTML output', [ARCHETYPES_ROUTE]);
  if (archetypesInSitemap) fail('html.archetypes.remove', 'removed archetypes page must be absent from sitemap', [ARCHETYPES_ROUTE]);
}

for (const info of infos) {
  if (info.jsonErrors.length) fail('jsonld.invalid', 'invalid application/ld+json block', [info.route]);
  if (noindexRoutes.has(info.route) && sitemapUrls.has(info.url)) fail('sitemap.noindex', 'noindex HTML must not be listed in sitemap', [info.route]);
}
if (globalIdGraph.conflicts.length) fail('jsonld.id.conflict', 'JSON-LD @id is reused globally with conflicting @type/core URL values', globalIdGraph.conflicts);

const langFailures = [];
const titleFailures = [];
const descriptionFailures = [];
const canonicalFailures = [];
const h1Failures = [];
const ogFailures = [];
const twitterFailures = [];
const rssFailures = [];
const graphFailures = [];
const breadcrumbFailures = [];
const imageFailures = [];
const articleFailures = [];
const homepageFailures = [];

for (const info of sitemapInfos.sort((a, b) => routeSort(a.route, b.route))) {
  const canonical = linksByRel(info, 'canonical').map(attrs => attrs.get('href') ?? '');
  const canonicalUrl = canonical[0] ?? '';
  const description = metasBy(info, 'name', 'description');
  const ogType = firstMeta(info, 'property', 'og:type');
  const ogUrl = firstMeta(info, 'property', 'og:url');
  const ogTitle = firstMeta(info, 'property', 'og:title');
  const ogDescription = firstMeta(info, 'property', 'og:description');
  const ogSiteName = firstMeta(info, 'property', 'og:site_name');
  const ogLocale = firstMeta(info, 'property', 'og:locale');
  const ogImage = firstMeta(info, 'property', 'og:image');
  const ogImageWidth = firstMeta(info, 'property', 'og:image:width');
  const ogImageHeight = firstMeta(info, 'property', 'og:image:height');
  const twitterCard = firstMeta(info, 'name', 'twitter:card');
  const twitterTitle = firstMeta(info, 'name', 'twitter:title');
  const twitterDescription = firstMeta(info, 'name', 'twitter:description');
  const twitterImage = firstMeta(info, 'name', 'twitter:image');
  const types = info.schemaTypes;
  const schemas = info.schemas.flatMap(schema => flattenSchema(schema));
  const isArticle = isArticleRoute(info.route);

  if (info.lang !== expectedLang(info.route)) langFailures.push(`${info.route} expected ${expectedLang(info.route)} got ${info.lang || '<missing>'}`);
  if (!info.title) titleFailures.push(info.route);
  if (description.length !== 1 || !description[0]) descriptionFailures.push(info.route);
  if (canonical.length !== 1 || canonicalUrl !== info.url) canonicalFailures.push(info.route);
  if (info.h1s.length !== 1 || !info.h1s[0]) h1Failures.push(info.route);

  if (!ogType || !['website', 'article'].includes(ogType)) ogFailures.push(`${info.route} og:type`);
  if (isArticle && ogType !== 'article') ogFailures.push(`${info.route} og:type must be article`);
  if (!isArticle && ogType === 'article') ogFailures.push(`${info.route} og:type must not be article`);
  if (ogUrl !== info.url) ogFailures.push(`${info.route} og:url`);
  if (!ogTitle) ogFailures.push(`${info.route} og:title`);
  if (!ogDescription) ogFailures.push(`${info.route} og:description`);

  if (!twitterCard) twitterFailures.push(`${info.route} twitter:card`);
  if (!twitterTitle) twitterFailures.push(`${info.route} twitter:title`);
  if (!twitterDescription) twitterFailures.push(`${info.route} twitter:description`);

  if (!ogImage) imageFailures.push(`${info.route} og:image`);
  if (ogImage) {
    const parsedImage = safeUrl(ogImage);
    if (!parsedImage || parsedImage.origin !== SITE_URL.origin) {
      imageFailures.push(`${info.route} og:image absolute site URL`);
    } else {
      const imageFile = assetFromSiteUrl(parsedImage);
      if (!imageFile || !existsSync(imageFile)) {
        imageFailures.push(`${info.route} og:image file missing ${parsedImage.pathname}`);
      } else {
        const dimensions = imageDimensions(imageFile);
        if (!dimensions) {
          imageFailures.push(`${info.route} og:image unsupported or unreadable dimensions`);
        } else {
          if (String(dimensions.width) !== String(ogImageWidth ?? '')) imageFailures.push(`${info.route} og:image:width actual ${dimensions.width} metadata ${ogImageWidth || '<missing>'}`);
          if (String(dimensions.height) !== String(ogImageHeight ?? '')) imageFailures.push(`${info.route} og:image:height actual ${dimensions.height} metadata ${ogImageHeight || '<missing>'}`);
        }
      }
    }
  }
  if (!twitterImage) imageFailures.push(`${info.route} twitter:image`);
  if (ogImage && twitterImage && ogImage !== twitterImage) imageFailures.push(`${info.route} twitter:image mismatch`);
  if (!ogImageWidth || !/^\d+$/.test(ogImageWidth)) imageFailures.push(`${info.route} og:image:width`);
  if (!ogImageHeight || !/^\d+$/.test(ogImageHeight)) imageFailures.push(`${info.route} og:image:height`);

  if (!types.has('Organization') || !types.has('WebSite')) graphFailures.push(`${info.route} Organization/WebSite`);

  if (info.route === '/') {
    if (ogType !== 'website') homepageFailures.push('og:type');
    if (ogSiteName !== 'metamodern.md') homepageFailures.push('og:site_name');
    if (ogLocale !== 'en_US') homepageFailures.push('og:locale');
    if (!ogImage) homepageFailures.push('og:image');
    if (twitterCard !== 'summary_large_image') homepageFailures.push('twitter:card summary_large_image');
    if (!twitterImage) homepageFailures.push('twitter:image');
  }

  if (isArticle) {
    const articleId = `${canonicalUrl}#article`;
    const webPageId = `${canonicalUrl}#webpage`;
    const article = schemas.find(schema => nodeHasType(schema, 'Article') && schema['@id'] === articleId) ?? schemas.find(schema => nodeHasType(schema, 'Article'));
    const webPage = schemas.find(schema => nodeHasType(schema, 'WebPage') && schema['@id'] === webPageId);
    const modifiedMeta = firstMeta(info, 'property', 'article:modified_time');
    const publishedMeta = firstMeta(info, 'property', 'article:published_time');

    if (!publishedMeta) articleFailures.push(`${info.route} article:published_time`);
    if (!article) {
      articleFailures.push(`${info.route} Article JSON-LD`);
    } else {
      if (article['@id'] !== articleId) articleFailures.push(`${info.route} Article.@id`);
      if (!article.headline) articleFailures.push(`${info.route} Article.headline`);
      if (!article.description) articleFailures.push(`${info.route} Article.description`);
      if (!article.image || article.image !== ogImage) articleFailures.push(`${info.route} Article.image`);
      if (!article.datePublished || parseTruthfulDate(article.datePublished) === null) articleFailures.push(`${info.route} Article.datePublished`);
      if (!article.dateModified || parseTruthfulDate(article.dateModified) === null) articleFailures.push(`${info.route} Article.dateModified`);
      if (article.datePublished && article.dateModified && parseTruthfulDate(article.datePublished) !== null && parseTruthfulDate(article.dateModified) !== null && parseTruthfulDate(article.dateModified) < parseTruthfulDate(article.datePublished)) articleFailures.push(`${info.route} Article.dateModified before datePublished`);
      if (publishedMeta && article.datePublished && publishedMeta !== article.datePublished) articleFailures.push(`${info.route} article:published_time mismatch`);
      if (!modifiedMeta) articleFailures.push(`${info.route} article:modified_time`);
      if (modifiedMeta && article.dateModified && !sameInstant(modifiedMeta, article.dateModified)) articleFailures.push(`${info.route} article:modified_time mismatch`);
      if (getIdReference(article.mainEntityOfPage) !== webPageId) articleFailures.push(`${info.route} Article.mainEntityOfPage`);
      if (!article.author?.name) articleFailures.push(`${info.route} Article.author.name`);
      if (article.publisher?.['@id'] !== 'https://metamodern.company/#organization') articleFailures.push(`${info.route} Article.publisher`);
    }
    if (!webPage) articleFailures.push(`${info.route} WebPage.@id`);

    const expectedBreadcrumbUrls = [`${SITE}/`, `${SITE}${langPrefix(info.route)}/blog/`, info.url];
    const visibleBreadcrumbError = validateVisibleArticleBreadcrumb(info, expectedBreadcrumbUrls);
    if (visibleBreadcrumbError) breadcrumbFailures.push(`${info.route} ${visibleBreadcrumbError}`);
    const breadcrumbNodes = schemas.filter(schema => nodeHasType(schema, 'BreadcrumbList'));
    const matchingBreadcrumb = breadcrumbNodes.some(node => {
      const urls = extractBreadcrumbUrls(node);
      return urls.length === expectedBreadcrumbUrls.length && urls.every((url, index) => url === expectedBreadcrumbUrls[index]);
    });
    if (!matchingBreadcrumb) breadcrumbFailures.push(`${info.route} BreadcrumbList URLs/order`);
  }
}

const indexableRouteSet = new Set(sitemapInfos.map(info => info.route));
const groups = new Map();
for (const info of sitemapInfos) {
  const key = equivalenceKey(info.route);
  if (!key) continue;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(info);
}

for (const [key, group] of groups) {
  const byLang = new Map(group.map(info => [expectedLang(info.route), info.url]).sort((a, b) => routeSort(a[0], b[0])));
  const translated = group.length > 1;
  const defaultUrl = byLang.get('en') ?? [...byLang.values()].sort(routeSort)[0];
  for (const info of group) {
    const alternatesRaw = linksByRel(info, 'alternate').filter(attrs => attrs.has('hreflang'));
    if (!translated && alternatesRaw.length === 0) continue;

    const alternates = new Map();
    for (const attrs of alternatesRaw) {
      const lang = (attrs.get('hreflang') ?? '').toLowerCase();
      const href = attrs.get('href') ?? '';
      const resolved = resolveHrefToSiteUrl(href, info.url);
      if (!lang) fail('hreflang.lang.missing', `${info.route} has hreflang without language`, [info.route]);
      if (!resolved) {
        fail('hreflang.href.invalid', `${info.route} has non-site or malformed hreflang href`, [href || '<empty>']);
        continue;
      }
      const parsed = safeUrl(resolved);
      const route = parsed ? routeFromPathname(parsed.pathname) : '';
      if (!indexableRouteSet.has(route)) fail('hreflang.generated-route', `${info.route} hreflang href must point to a generated sitemap route`, [route || resolved]);
      if (alternates.has(lang)) fail('hreflang.duplicate', `${info.route} duplicates hreflang ${lang}`, [info.route]);
      alternates.set(lang, resolved);
    }

    if (translated) {
      const expectedLangs = new Set([...byLang.keys(), 'x-default']);
      const missing = [...expectedLangs].filter(lang => !alternates.has(lang));
      const extra = [...alternates.keys()].filter(lang => !expectedLangs.has(lang));
      if (missing.length) fail('hreflang.missing', `${info.route} ${key} missing hreflang: ${missing.sort().join(',')}`, [info.route]);
      if (extra.length) fail('hreflang.extra', `${info.route} ${key} has extra hreflang: ${extra.sort().join(',')}`, [info.route]);
      for (const [lang, url] of byLang) {
        if (alternates.get(lang) !== url) fail('hreflang.reciprocal', `${info.route} hreflang ${lang} should be ${url}`, [info.route]);
      }
      if (alternates.get('x-default') !== defaultUrl) fail('hreflang.x-default', `${info.route} x-default should be ${defaultUrl}`, [info.route]);
    } else {
      const selfLang = expectedLang(info.route);
      const extra = [...alternates.keys()].filter(lang => lang !== selfLang && lang !== 'x-default');
      if (extra.length) fail('hreflang.singleton.extra', `${info.route} singleton has extra hreflang: ${extra.sort().join(',')}`, [info.route]);
      if (alternates.has(selfLang) && alternates.get(selfLang) !== info.url) fail('hreflang.singleton.self', `${info.route} self hreflang should be ${info.url}`, [info.route]);
      if (alternates.has('x-default') && alternates.get('x-default') !== info.url) fail('hreflang.singleton.x-default', `${info.route} singleton x-default should be self`, [info.route]);
    }
  }
}

const home = byRoute.get('/');
if (!home) {
  fail('homepage.missing', 'missing generated homepage');
} else {
  const rssLinks = linksByRel(home, 'alternate').filter(attrs => (attrs.get('type') ?? '').toLowerCase() === 'application/rss+xml');
  const hasFeedDiscovery = rssLinks.some(attrs => resolveHrefToSiteUrl(attrs.get('href') ?? '', home.url) === `${SITE}/feed.xml`);
  if (!hasFeedDiscovery) rssFailures.push('/ homepage RSS autodiscovery');

  const visibleAnchors = anchorTags(home.html).map(anchor => ({ href: anchor.attrs.get('href') ?? '', text: anchor.text }));
  for (const requiredOrigin of ['https://metamodern.company', 'https://metamodern.studio']) {
    const found = visibleAnchors.some(anchor => {
      const parsed = safeUrl(anchor.href);
      return parsed?.origin === requiredOrigin && cleanText(anchor.text);
    });
    if (!found) homepageFailures.push(`visible link ${requiredOrigin}/`);
  }
}

const feed = parseFeedItems(path.join(root, 'feed.xml'));
if (!feed) {
  fail('rss.feed.missing', 'missing feed.xml');
} else {
  if (!/^en(?:-|$)/i.test(feed.channelLanguage)) rssFailures.push(`feed language ${feed.channelLanguage || '<missing>'}`);
  const expectedEnglishArticleUrls = new Set(sitemapInfos.filter(info => isArticleRoute(info.route) && expectedLang(info.route) === 'en').map(info => info.url));
  const itemUrls = new Set();
  for (const item of feed.items) {
    const parsed = safeUrl(item.link);
    if (!parsed || parsed.origin !== SITE_URL.origin) {
      rssFailures.push(`feed item malformed/non-site link ${item.link || '<empty>'}`);
      continue;
    }
    const route = routeFromPathname(parsed.pathname);
    itemUrls.add(parsed.href);
    if (!isArticleRoute(route) || expectedLang(route) !== 'en') rssFailures.push(`feed item is not an English article ${parsed.href}`);
    if (!expectedEnglishArticleUrls.has(parsed.href)) rssFailures.push(`feed item link not in English article routes ${parsed.href}`);
    if (item.guid && item.guid !== item.link) rssFailures.push(`feed guid mismatch ${item.link}`);
    if (!item.pubDate || Number.isNaN(Date.parse(item.pubDate))) rssFailures.push(`feed pubDate invalid ${item.link}`);
  }
  const missingFeedItems = [...expectedEnglishArticleUrls].filter(url => !itemUrls.has(url));
  const extraFeedItems = [...itemUrls].filter(url => !expectedEnglishArticleUrls.has(url));
  if (missingFeedItems.length) rssFailures.push(`feed missing English articles ${missingFeedItems.sort(routeSort).join(',')}`);
  if (extraFeedItems.length) rssFailures.push(`feed has extra items ${extraFeedItems.sort(routeSort).join(',')}`);
}

if (langFailures.length) fail('html.lang', `${langFailures.length} page(s) have unexpected html lang`, langFailures);
if (titleFailures.length) fail('title.missing', `${titleFailures.length} sitemap page(s) missing title`, titleFailures);
if (descriptionFailures.length) fail('description.missing', `${descriptionFailures.length} sitemap page(s) missing meta description`, descriptionFailures);
if (canonicalFailures.length) fail('canonical.mismatch', `${canonicalFailures.length} sitemap page(s) missing/mismatched canonical`, canonicalFailures);
if (h1Failures.length) fail('h1.count', `${h1Failures.length} sitemap page(s) do not have exactly one H1`, h1Failures);
if (ogFailures.length) fail('og.required', `${ogFailures.length} Open Graph field(s) missing/mismatched`, ogFailures);
if (twitterFailures.length) fail('twitter.required', `${twitterFailures.length} Twitter field(s) missing`, twitterFailures);
if (rssFailures.length) fail('rss.feed', `${rssFailures.length} RSS/feed field(s) missing/mismatched`, rssFailures);
if (graphFailures.length) fail('jsonld.graph', `${graphFailures.length} sitemap page(s) missing Organization/WebSite JSON-LD`, graphFailures);
if (breadcrumbFailures.length) fail('breadcrumbs.article', `${breadcrumbFailures.length} article breadcrumb field(s) missing/mismatched`, breadcrumbFailures);
if (imageFailures.length) fail('image.metadata', `${imageFailures.length} image metadata field(s) missing/mismatched`, imageFailures);
if (articleFailures.length) fail('jsonld.article', `${articleFailures.length} Article/WebPage JSON-LD field(s) missing/mismatched`, articleFailures);
if (homepageFailures.length) fail('homepage.social-links', `${homepageFailures.length} homepage social/link field(s) missing/mismatched`, homepageFailures);

console.log(`SEO output root: ${sanitizeDiagnosticValue(displayRoot)}`);
console.log(`Archetypes mode: ${archetypesMode}`);
console.log(`HTML: ${infos.length} total; ${classifiedRoutes.size} classified (${sitemapUrls.size} sitemap + ${noindexInfos.length} noindex + ${knownOrphanInfos.length} pending known orphan); ${unknownIndexable.length} unclassified indexable.`);

if (!failures.length) {
  console.log('PASS: generated SEO output verified.');
  process.exit(0);
}

for (const item of failures.sort((a, b) => routeSort(a.code, b.code))) {
  const suffix = item.routes.length ? `: ${formatDiagnosticRoutes(item.routes)}` : '';
  console.log(`FAIL ${item.code}: ${sanitizeDiagnosticValue(item.message)}${suffix}`);
}
process.exit(1);
