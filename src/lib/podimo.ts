export const PODIMO_URL = "https://podimo.com";

export type Locale = string;

export interface Region {
  locale: Locale; // The path segment Podimo uses, e.g. "dk" or "latam"
  language: string; // The hreflang it's published under, e.g. "da-DK" or "es-419"
  name: string; // English region name, e.g. "Denmark" or "Latin America"
}

const FALLBACK_REGIONS: Region[] = [{ locale: "nl", language: "nl-NL", name: "Netherlands" }];
const REGIONS_TTL = 60 * 60 * 1000;

let regionsCache: { regions: Promise<Region[]>; expires: number } | undefined;

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

// Podimo lists every market it runs as an hreflang alternate. The x-default entry is its generic English site, which has no catalogue, so it's left out.
const fetchRegions = async (): Promise<Region[]> => {
  const response = await fetchPodimo("en");
  if (!response.ok) throw new Error(`Podimo returned ${response.status} while loading regions`);

  const payload = getPayload(await response.text());
  const alternates = [...payload.matchAll(/"hrefLang":"([^"]+)","href":"https:\/\/podimo\.com\/([\w-]+)\/?"/g)];
  const fallbackLocale = alternates.find(([, language]) => language === "x-default")?.[2];

  const regions = new Map<Locale, Region>();
  for (const [, language, locale] of alternates) {
    if (language === "x-default" || locale === fallbackLocale || regions.has(locale)) continue;

    const regionCode = language.split("-")[1] || "";
    let name = locale.toUpperCase();
    try {
      name = regionNames.of(regionCode.toUpperCase()) || name;
    } catch {}

    regions.set(locale, { locale, language, name });
  }

  if (!regions.size) throw new Error("No regions found on Podimo");
  return [...regions.values()].sort((a, b) => a.name.localeCompare(b.name));
};

// Cached per worker instance for an hour; a failed lookup isn't cached so the next request retries
export const getRegions = (): Promise<Region[]> => {
  if (!regionsCache || regionsCache.expires < Date.now()) {
    const regions = fetchRegions().catch((e) => {
      console.error(e);
      regionsCache = undefined;
      return FALLBACK_REGIONS;
    });
    regionsCache = { regions, expires: Date.now() + REGIONS_TTL };
  }
  return regionsCache.regions;
};

// Maps a browser language to the closest Podimo market, e.g. "nl-BE" → be, "nb" → no, "es-AR" → latam, "de-AT" → de
const getLocaleFromLanguage = (regions: Region[], tag: string): Locale | undefined => {
  const [rawLanguage, region] = tag.toLowerCase().split("-");
  const language = rawLanguage === "no" || rawLanguage === "nn" ? "nb" : rawLanguage;
  const candidates = regions.filter((item) => item.language.toLowerCase().split("-")[0] === language);

  const match = candidates.find((item) => item.language.toLowerCase() === `${language}-${region}`) ?? (region ? candidates.find((item) => item.language.endsWith("-419")) : undefined) ?? candidates.find((item) => item.language.toLowerCase() === `${language}-${language}`) ?? candidates[0];

  return match?.locale;
};

// Picks the market from the URL, then the remembered choice, then the browser's languages
export const resolveLocale = (regions: Region[], url: URL, cookie: string | undefined, acceptLanguage: string | null): Locale => {
  for (const value of [url.searchParams.get("locale"), cookie]) {
    if (value && regions.some((region) => region.locale === value)) return value;
  }

  for (const language of (acceptLanguage || "").split(",")) {
    const locale = getLocaleFromLanguage(regions, language.split(";")[0].trim());
    if (locale) return locale;
  }

  return regions.find((region) => region.locale === "nl")?.locale ?? regions[0].locale;
};

export interface Podcast {
  id: string;
  title: string;
  authorName: string;
  description: string;
  coverImageUrl: string;
  coverColor: string;
  episodeCount: number;
  url: string;
}

export interface TrendingPodcast {
  id: string;
  slug: string;
  title: string;
  authorName: string;
  coverImageUrl: string;
  coverColor: string;
}

// Fetches a Podimo page through Cloudflare's cache so repeated lookups don't hit Podimo every time
export const fetchPodimo = (locale: Locale, path = "") => {
  return fetch(`${PODIMO_URL}/${locale}${path}`, { cf: { cacheTtl: 3600, cacheEverything: true } } as RequestInit);
};

// Podimo is a Next.js app: the page data lives in self.__next_f.push([1, "..."]) chunks as an escaped RSC payload
export const getPayload = (html: string) => {
  return [...html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)].map(([, chunk]) => JSON.parse(chunk)).join("");
};

// Reads the first value of a field in the payload, e.g. "title":"De Dag" or "episodeCount":301
export const getField = (payload: string, name: string) => {
  const match = payload.match(new RegExp(`"${name}":("(?:[^"\\\\]|\\\\.)*"|-?\\d+(?:\\.\\d+)?|true|false|null)`));
  return match ? JSON.parse(match[1]) : undefined;
};

// Long strings are moved to their own text row and referenced as "$44", stored as 44:T<byte length in hex>,<text>
export const resolveText = (payload: string, value: string) => {
  const match = typeof value === "string" && value.match(/^\$([0-9a-f]+)$/);
  if (!match) return value;

  const row = payload.match(new RegExp(`(?:^|\\n)${match[1]}:T([0-9a-f]+),`));
  if (!row) return "";

  const length = parseInt(row[1], 16);
  const start = row.index + row[0].length;
  const bytes = new TextEncoder().encode(payload.slice(start, start + length));
  return new TextDecoder().decode(bytes.slice(0, length));
};

// Reads the JSON array or object starting at the given offset, skipping over brackets inside strings
const readJson = (payload: string, start: number) => {
  let depth = 0;
  let inString = false;
  for (let i = start; i < payload.length; i++) {
    const char = payload[i];
    if (inString) {
      if (char === "\\") i++;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === "[" || char === "{") {
      depth++;
    } else if ((char === "]" || char === "}") && --depth === 0) {
      return JSON.parse(payload.slice(start, i + 1));
    }
  }
};

export const getPodcast = async (slug: string, locale: Locale): Promise<Podcast | null> => {
  const response = await fetchPodimo(locale, `/shows/${slug}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Podimo returned an unexpected response (${response.status}). Please try again in a moment.`);

  const payload = getPayload(await response.text());
  const start = payload.search(/"id":"[a-f0-9-]{36}","isAudiobook"/);
  if (start === -1) return null;

  const show = payload.slice(start);
  return {
    id: getField(show, "id"),
    title: getField(show, "title"),
    authorName: getField(show, "authorName"),
    description: resolveText(payload, getField(show, "description")) || "",
    coverImageUrl: getField(show, "coverImageUrl"),
    coverColor: getField(show, "coverColor") || "#a3e635",
    episodeCount: getField(show, "episodeCount"),
    url: `${PODIMO_URL}/${locale}/shows/${slug}`,
  };
};

export const getTrending = async (locale: Locale): Promise<TrendingPodcast[]> => {
  const response = await fetchPodimo(locale);
  if (!response.ok) return [];

  // The heading is translated per market, so find the section by its component name instead
  const payload = getPayload(await response.text());
  const section = payload.indexOf('"componentName":"PodcastsSection"');
  const start = payload.indexOf('"collection":[', section);
  if (section === -1 || start === -1) return [];

  const collection = readJson(payload, start + '"collection":'.length) || [];
  return collection.map((podcast) => ({
    id: podcast.id,
    slug: podcast.slug,
    title: podcast.title,
    authorName: podcast.authorName,
    coverImageUrl: podcast.images?.cover?.url,
    coverColor: podcast.images?.cover?.color,
  }));
};
