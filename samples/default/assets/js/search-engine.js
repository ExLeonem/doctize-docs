/*
 * Doctize search engine: full-text search over the records of search-index.js.
 *
 * Features: camelCase and snake_case aware tokenization ("CacheBuilder" is found by "builder"),
 * prefix matching while typing, typo tolerance, BM25 ranking with field weights, and snippets with
 * highlighted matches. Results can be limited to the API reference or to the guides. It has no
 * dependencies and works from file:// too.
 *
 * Usage:
 *   const index = DoctizeSearch.createIndex(window.DOCTIZE_SEARCH_INDEX.records);
 *   const results = DoctizeSearch.search(index, "cache bulder");
 *   const methods = DoctizeSearch.search(index, "evict", { scope: "api" });
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DoctizeSearch = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const FIELD_WEIGHTS = { title: 8, heading: 5, keywords: 4, text: 1 };
  const K1 = 1.2;
  const B = 0.75;
  const MAX_PREFIX_EXPANSIONS = 40;
  const MAX_RESULTS = 12;
  const MAX_CHUNKS_PER_PAGE = 3;
  const SNIPPET_LENGTH = 170;
  const SCOPES = ["api", "guides"];

  /** The area a record belongs to; indexes written before areas existed only had guides and API pages mixed. */
  function areaOf(record) {
    return record.area || "guides";
  }

  /** Lower-cased word tokens; identifiers are also split at case changes and underscores. */
  function tokenize(text) {
    const tokens = [];
    const words = String(text || "").match(/[\p{L}\p{N}]+(?:[_'’][\p{L}\p{N}]+)*/gu) || [];
    for (const word of words) {
      tokens.push(word.toLowerCase());
      const parts = word
        .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
        .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
        .split(/[\s_'’]+/)
        .map((part) => part.toLowerCase())
        .filter(Boolean);
      if (parts.length > 1) tokens.push(...parts);
    }
    return tokens;
  }

  function createIndex(records) {
    const docs = records.map((record) => {
      const isPageStart = !record.heading;
      const fields = {
        title: tokenize(record.title),
        heading: tokenize(record.heading),
        keywords: tokenize(record.keywords),
        text: tokenize(record.text),
      };
      // Chunks below a heading only weakly match on the page title, so that a page title does not
      // drown the specific section a query is really about.
      return { record, fields, titleWeight: isPageStart ? 1 : 0.25 };
    });

    const postings = {};
    const lengthSums = {};
    for (const field of Object.keys(FIELD_WEIGHTS)) {
      postings[field] = new Map();
      lengthSums[field] = 0;
    }
    docs.forEach((doc, id) => {
      for (const field of Object.keys(FIELD_WEIGHTS)) {
        const tokens = doc.fields[field];
        lengthSums[field] += tokens.length;
        const counts = new Map();
        for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
        for (const [token, count] of counts) {
          let posting = postings[field].get(token);
          if (!posting) postings[field].set(token, (posting = []));
          posting.push([id, count]);
        }
      }
    });

    const terms = {};
    const averageLength = {};
    const allTerms = new Set();
    for (const field of Object.keys(FIELD_WEIGHTS)) {
      terms[field] = [...postings[field].keys()].sort();
      terms[field].forEach((term) => allTerms.add(term));
      averageLength[field] = lengthSums[field] / Math.max(1, docs.length) || 1;
    }
    return { docs, postings, terms, averageLength, allTerms: [...allTerms].sort() };
  }

  /** Terms of `sorted` that start with `prefix`. */
  function prefixMatches(sorted, prefix) {
    let low = 0;
    let high = sorted.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (sorted[middle] < prefix) low = middle + 1;
      else high = middle;
    }
    const matches = [];
    for (let i = low; i < sorted.length && sorted[i].startsWith(prefix); i++) matches.push(sorted[i]);
    return matches;
  }

  /** Edit distance with early exit once it exceeds `limit`. */
  function withinEditDistance(a, b, limit) {
    if (Math.abs(a.length - b.length) > limit) return false;
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const current = [i];
      let rowMin = i;
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
        rowMin = Math.min(rowMin, current[j]);
      }
      if (rowMin > limit) return false;
      previous = current;
    }
    return previous[b.length] <= limit;
  }

  /** Every indexed term a query token stands for, with how closely it matches (1 = exact). */
  function expand(index, token) {
    const expansions = new Map();
    if (Object.keys(FIELD_WEIGHTS).some((field) => index.postings[field].has(token))) {
      expansions.set(token, 1);
    }
    for (const term of prefixMatches(index.allTerms, token).slice(0, MAX_PREFIX_EXPANSIONS)) {
      if (!expansions.has(term)) expansions.set(term, 0.75 * (token.length / term.length) + 0.1);
    }
    if (expansions.size === 0 && token.length >= 4) {
      const limit = token.length >= 8 ? 2 : 1;
      for (const term of index.allTerms) {
        if (withinEditDistance(token, term, limit)) expansions.set(term, 0.4);
      }
    }
    return expansions;
  }

  function idf(documentCount, documentFrequency) {
    return Math.log(1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5));
  }

  /** Scores all documents for one query token: doc id -> score. */
  function scoreToken(index, token) {
    const scores = new Map();
    const expansions = expand(index, token);
    for (const [term, closeness] of expansions) {
      for (const field of Object.keys(FIELD_WEIGHTS)) {
        const posting = index.postings[field].get(term);
        if (!posting) continue;
        const weight = FIELD_WEIGHTS[field];
        const inverse = idf(index.docs.length, posting.length);
        for (const [id, count] of posting) {
          const doc = index.docs[id];
          const length = doc.fields[field].length;
          const frequency = (count * (K1 + 1)) / (count + K1 * (1 - B + (B * length) / index.averageLength[field]));
          const fieldWeight = field === "title" ? weight * doc.titleWeight : weight;
          scores.set(id, (scores.get(id) || 0) + fieldWeight * inverse * frequency * closeness);
        }
      }
    }
    return scores;
  }

  function combine(perToken, requireAll, accept) {
    const combined = new Map();
    perToken.forEach((scores) => {
      for (const [id, score] of scores) {
        const entry = combined.get(id) || { score: 0, matched: 0 };
        entry.score += score;
        entry.matched += 1;
        combined.set(id, entry);
      }
    });
    const ranked = [];
    for (const [id, entry] of combined) {
      if (!accept(id)) continue;
      if (requireAll && entry.matched < perToken.length) continue;
      ranked.push({ id, score: entry.score * (entry.matched / perToken.length) });
    }
    return ranked;
  }

  /** Rewards exact phrase matches and titles that equal the query; "get()" counts as the name "get". */
  function phraseBonus(doc, query) {
    const phrase = query.toLowerCase().trim();
    const title = (doc.record.title || "").toLowerCase();
    const heading = (doc.record.heading || "").toLowerCase().replace(/\(.*\)$/, "");
    let bonus = 0;
    if (heading === phrase || (!heading && title === phrase)) bonus += 30;
    else if (heading.includes(phrase) || (!heading && title.includes(phrase))) bonus += 12;
    if ((doc.record.text || "").toLowerCase().includes(phrase)) bonus += 3;
    return bonus;
  }

  function escapeHtml(text) {
    return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  /** Escapes `text` and wraps every occurrence of a query token (or a word starting with it) in <mark>. */
  function highlight(text, tokens) {
    if (!tokens.length) return escapeHtml(text);
    const pattern = new RegExp(
      "(" + tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")",
      "giu"
    );
    return text
      .split(pattern)
      .map((part, i) => (i % 2 === 1 ? "<mark>" + escapeHtml(part) + "</mark>" : escapeHtml(part)))
      .join("");
  }

  function snippet(text, tokens) {
    if (!text) return "";
    const lower = text.toLowerCase();
    let start = -1;
    for (const token of tokens) {
      const at = lower.indexOf(token);
      if (at >= 0 && (start < 0 || at < start)) start = at;
    }
    if (start < 0) return escapeHtml(text.slice(0, SNIPPET_LENGTH)) + (text.length > SNIPPET_LENGTH ? "…" : "");
    const from = Math.max(0, start - 50);
    const to = Math.min(text.length, from + SNIPPET_LENGTH);
    return (from > 0 ? "…" : "") + highlight(text.slice(from, to), tokens) + (to < text.length ? "…" : "");
  }

  /** The areas present in the index, e.g. ["api", "guides"]; a scope selector is only useful with two. */
  function areas(index) {
    const present = new Set(index.docs.map((doc) => areaOf(doc.record)));
    return SCOPES.filter((area) => present.has(area));
  }

  /**
   * @param options optional: `limit`, the maximum number of results, and `scope`, "api" or "guides"
   *   to search only there (anything else searches everything)
   * @returns results sorted by relevance; hits on the same page are grouped, the best first:
   *   { url, title, section, heading, kind, area, titleHtml, headingHtml, snippetHtml, score, child }
   */
  function search(index, query, options) {
    const limit = (options && options.limit) || MAX_RESULTS;
    const scope = options && SCOPES.includes(options.scope) ? options.scope : null;
    const accept = scope ? (id) => areaOf(index.docs[id].record) === scope : () => true;
    const queryTokens = [...new Set(tokenize(query))];
    if (!queryTokens.length) return [];

    const perToken = queryTokens.map((token) => scoreToken(index, token));
    let ranked = combine(perToken, true, accept);
    if (ranked.length === 0 && queryTokens.length > 1) ranked = combine(perToken, false, accept);
    ranked = ranked.map((hit) => ({ ...hit, score: hit.score + phraseBonus(index.docs[hit.id], query) }));
    ranked.sort((a, b) => b.score - a.score);

    const pages = new Map();
    for (const hit of ranked) {
      const doc = index.docs[hit.id];
      const page = doc.record.url.split("#")[0];
      const group = pages.get(page) || pages.set(page, []).get(page);
      if (group.length < MAX_CHUNKS_PER_PAGE) group.push({ doc, score: hit.score });
    }

    const highlightTokens = queryTokens.filter((token) => token.length > 1 || queryTokens.length === 1);
    const results = [];
    for (const group of pages.values()) {
      group.forEach(({ doc, score }, position) => {
        const r = doc.record;
        results.push({
          url: r.url,
          title: r.title,
          section: r.section,
          heading: r.heading,
          kind: r.kind || (r.heading ? "section" : "page"),
          area: areaOf(r),
          titleHtml: highlight(r.title, highlightTokens),
          headingHtml: highlight(r.heading || "", highlightTokens),
          snippetHtml: snippet(r.text, highlightTokens),
          score: score,
          child: position > 0,
        });
      });
      if (results.length >= limit) break;
    }
    return results.slice(0, limit);
  }

  return { tokenize, createIndex, search, areas };
});
