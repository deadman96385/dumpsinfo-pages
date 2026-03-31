/* AndroidDumps Search - static client-side search over JSON shards */
(function () {
  "use strict";

  const PAGE_SIZE = 50;
  const UNKNOWN_VALUE = "unknown";
  let allRecords = [];
  let filteredRecords = [];
  let facets = {};
  let stats = {};
  let manifest = {};
  let loadedShards = new Set();
  let currentPage = 1;
  let initialized = false;

  // DOM refs
  const $search = document.getElementById("search");
  const $results = document.getElementById("results");
  const $resultCount = document.getElementById("result-count");
  const $pagination = document.getElementById("pagination");
  const $statsBar = document.getElementById("stats-banner");
  const $sort = document.getElementById("sort-select");
  const $filterBrand = document.getElementById("filter-brand");
  const $filterRelease = document.getElementById("filter-release");
  const $filterCpu = document.getElementById("filter-cpu");
  const $filterPlatform = document.getElementById("filter-platform");
  const $filterGpu = document.getElementById("filter-gpu");
  const $filterSize = document.getElementById("filter-size");
  const $filterAB = document.getElementById("filter-ab");
  const $filterToggle = document.getElementById("filter-toggle");
  const $filterToggleCount = document.getElementById("filter-toggle-count");
  const $filtersPanel = document.getElementById("filters-panel");
  const mobileFiltersMedia = window.matchMedia("(max-width: 768px)");

  // Init
  async function init() {
    if (initialized) return;
    initialized = true;
    try {
      const [mRes, fRes, sRes] = await Promise.all([
        fetchJson("data/manifest.json"),
        fetchJson("data/facets.json"),
        fetchJson("data/stats.json"),
      ]);
      manifest = mRes;
      facets = fRes;
      stats = sRes;
    } catch (e) {
      console.error("Failed to initialize search index", e);
      $results.innerHTML = renderLoadError("index data");
      return;
    }

    renderStats();
    renderFilters();
    syncFilterPanelForViewport();
    syncFilterGroupsForViewport();

    // Load all shards (they're small enough)
    await loadAllShards();

    // Parse URL params
    applyURLParams();

    // Event listeners
    const debouncedSearch = debounce(doSearch, 200);
    $search.addEventListener("input", () => {
      clearPendingResults();
      debouncedSearch();
    });
    $sort.addEventListener("change", doSearch);
    $filterBrand.addEventListener("change", doSearch);
    $filterAB.addEventListener("change", doSearch);
    if ($filterToggle) {
      $filterToggle.addEventListener("click", toggleFilters);
    }
    if (mobileFiltersMedia.addEventListener) {
      mobileFiltersMedia.addEventListener("change", syncFilterPanelForViewport);
      mobileFiltersMedia.addEventListener("change", syncFilterGroupsForViewport);
    } else if (mobileFiltersMedia.addListener) {
      mobileFiltersMedia.addListener(syncFilterPanelForViewport);
      mobileFiltersMedia.addListener(syncFilterGroupsForViewport);
    }
    document
      .querySelectorAll("#filter-release input, #filter-cpu input, #filter-platform input, #filter-gpu input, #filter-size input")
      .forEach((el) => el.addEventListener("change", doSearch));
    $results.addEventListener("click", handleResultClick);

    doSearch();
  }

  // Load shards
  async function loadAllShards() {
    const promises = [];
    for (const [letter, info] of Object.entries(manifest.shards || {})) {
      if (!loadedShards.has(letter)) {
        promises.push(
          fetchJson(`data/search/${info.file}`)
            .then((records) => {
              allRecords.push(...records);
              loadedShards.add(letter);
            })
            .catch((e) => {
              console.error(`Failed to load search shard ${info.file}`, e);
            })
        );
      }
    }
    await Promise.all(promises);
  }

  // Stats banner
  function renderStats() {
    const totalRepos = stats.total_repos ? stats.total_repos.toLocaleString() : "0";
    $statsBar.innerHTML = `
      <span><b>${totalRepos}</b> repos</span>
      <span><b>${stats.total_size_human}</b> total</span>
      <span><b>${stats.brand_count}</b> brands</span>
      <span><b>${stats.platform_count}</b> platforms</span>
    `;
  }

  // Filter sidebar
  function renderFilters() {
    // Brand dropdown
    const brands = Object.entries(facets.brand || {}).sort(
      (a, b) => b[1] - a[1]
    );
    let opts = '<option value="">All brands</option>';
    for (const [b, c] of brands) {
      opts += `<option value="${esc(b)}">${esc(b)} (${c})</option>`;
    }
    $filterBrand.innerHTML = opts;

    // Release checkboxes
    const releases = Object.entries(facets.release || {}).sort((a, b) => {
      if (a[0] === UNKNOWN_VALUE) return 1;
      if (b[0] === UNKNOWN_VALUE) return -1;
      const na = parseFloat(a[0]) || 0,
        nb = parseFloat(b[0]) || 0;
      return nb - na;
    });
    let relHtml = "";
    for (const [r, c] of releases) {
      relHtml += `<label><input type="checkbox" value="${esc(r)}"> ${esc(formatFacetLabel(r))} <span class="filter-count">${c}</span></label>`;
    }
    $filterRelease.innerHTML = relHtml;

    if ($filterCpu) $filterCpu.innerHTML = renderCheckboxFacet(facets.cpu_family || {}, {
      sort: "alpha",
      formatter: formatTitleWords,
    });
    if ($filterPlatform) $filterPlatform.innerHTML = renderCheckboxFacet(facets.platform || {}, {
      sort: "alpha",
      limit: 80,
    });
    if ($filterGpu) $filterGpu.innerHTML = renderCheckboxFacet(facets.gpu_family || {}, {
      sort: "alpha",
    });
    if ($filterSize) $filterSize.innerHTML = renderCheckboxFacet(facets.size_bucket || {}, {
      order: [
        "under 512 MB",
        "512 MB to 1 GB",
        "1 GB to 2 GB",
        "2 GB to 4 GB",
        "over 4 GB",
        UNKNOWN_VALUE,
      ],
    });
  }

  // Search + Filter
  function doSearch() {
    const query = ($search.value || "").toLowerCase().trim();
    const queryTokens = query
      .split(/[\s,]+/)
      .filter((t) => t.length >= 1);
    const brandFilter = $filterBrand.value;
    const abFilter = $filterAB.value;

    const releaseFilters = new Set();
    document
      .querySelectorAll("#filter-release input:checked")
      .forEach((el) => releaseFilters.add(normalizeFacetValue(el.value)));

    const cpuFilters = new Set();
    document
      .querySelectorAll("#filter-cpu input:checked")
      .forEach((el) => cpuFilters.add(normalizeFacetValue(el.value)));
    const platformFilters = new Set();
    document
      .querySelectorAll("#filter-platform input:checked")
      .forEach((el) => platformFilters.add(normalizeFacetValue(el.value)));
    const gpuFilters = new Set();
    document
      .querySelectorAll("#filter-gpu input:checked")
      .forEach((el) => gpuFilters.add(normalizeFacetValue(el.value)));
    const sizeFilters = new Set();
    document
      .querySelectorAll("#filter-size input:checked")
      .forEach((el) => sizeFilters.add(normalizeFacetValue(el.value)));

    filteredRecords = allRecords.filter((rec) => {
      const release = normalizeRelease(rec.release);
      const cpuFamily = normalizeFacetValue(rec.cpu_family || rec.platform_family);
      const platformNorm = normalizeFacetValue(rec.platform_norm);
      const gpuFamily = normalizeFacetValue(rec.gpu_family);
      const sizeBucket = normalizeFacetValue(rec.size_bucket);

      // Brand filter
      if (brandFilter && rec.brand_norm !== brandFilter) return false;

      // Release filter
      if (releaseFilters.size > 0 && !releaseFilters.has(release))
        return false;

      if (cpuFilters.size > 0 && !cpuFilters.has(cpuFamily))
        return false;
      if (platformFilters.size > 0 && !platformFilters.has(platformNorm))
        return false;
      if (gpuFilters.size > 0 && !gpuFilters.has(gpuFamily))
        return false;
      if (sizeFilters.size > 0 && !sizeFilters.has(sizeBucket))
        return false;

      // A/B filter
      if (abFilter === "true" && !rec.is_ab) return false;
      if (abFilter === "false" && rec.is_ab) return false;

      // Text search
      if (queryTokens.length > 0) {
        const tokens = rec.tokens || [];
        const tokenStr = tokens.join(" ");
        for (const qt of queryTokens) {
          if (!tokenStr.includes(qt)) return false;
        }
      }

      return true;
    });

    // Sort
    sortRecords();

    currentPage = 1;
    renderResults();
    updateFilterToggleCount({
      brandFilter,
      abFilter,
      releaseCount: releaseFilters.size,
      cpuCount: cpuFilters.size,
      platformCount: platformFilters.size,
      gpuCount: gpuFilters.size,
      sizeCount: sizeFilters.size,
    });
    updateURL();
  }

  function sortRecords() {
    const sortBy = $sort.value;
    filteredRecords.sort((a, b) => {
      switch (sortBy) {
        case "brand":
          return (a.brand_norm || "").localeCompare(b.brand_norm || "");
        case "release":
          return (
            (parseFloat(b.release) || 0) - (parseFloat(a.release) || 0)
          );
        case "size":
          return (b.repo_size_bytes || 0) - (a.repo_size_bytes || 0);
        case "branches":
          return (b.branch_count || 0) - (a.branch_count || 0);
        default:
          return 0;
      }
    });
  }

  // Render
  function renderResults() {
    const total = filteredRecords.length;
    $resultCount.textContent = `${total.toLocaleString()} result${total !== 1 ? "s" : ""}`;

    const start = (currentPage - 1) * PAGE_SIZE;
    const pageRecords = filteredRecords.slice(start, start + PAGE_SIZE);

    if (total === 0) {
      $results.innerHTML =
        '<div class="empty">No matching repos found.</div>';
      $pagination.innerHTML = "";
      return;
    }

    let html = "";
    for (const rec of pageRecords) {
      const fp = rec.fingerprint
        ? esc(rec.fingerprint).substring(0, 100)
        : "";
      const release = normalizeRelease(rec.release);
      const cpuFamily = normalizeFacetValue(rec.cpu_family || rec.platform_family);
      const gpuLabel = rec.gpu_label && normalizeFacetValue(rec.gpu_label) !== UNKNOWN_VALUE
        ? rec.gpu_label
        : rec.gpu_family;
      const tags = [];
      if (cpuFamily !== UNKNOWN_VALUE)
        tags.push(renderFilterTag("cpu", cpuFamily, cpuFamily, "cpu"));
      if (rec.platform_norm && normalizeFacetValue(rec.platform_norm) !== cpuFamily)
        tags.push(renderFilterTag("platform", rec.platform_norm, rec.platform_norm));
      if (gpuLabel && normalizeFacetValue(gpuLabel) !== UNKNOWN_VALUE)
        tags.push(renderFilterTag("gpu", gpuLabel, gpuLabel, "gpu"));
      if (rec.is_ab) tags.push(renderFilterTag("ab", "true", "A/B", "partition"));
      else tags.push(renderFilterTag("ab", "false", "A-only", "partition"));
      if (release !== UNKNOWN_VALUE)
        tags.push(renderFilterTag("release", release, `Android ${release}`, "android"));
      if (rec.size_human)
        tags.push(renderFilterTag("size", rec.size_bucket || rec.size_human, rec.size_human));

      html += `
        <article class="card">
          <a href="repo.html?id=${rec.repo_id}" class="card-link">
          <div class="card-header">
            <span class="card-title">${esc(rec.display_name || `${rec.brand || rec.path_brand} ${rec.codename || rec.path_device}`)}</span>
            <span class="card-path">${esc(rec.path_brand)}/${esc(rec.path_device)}</span>
          </div>
          ${rec.branch_count > 1 ? `<div class="card-meta"><span>${rec.branch_count} branches</span></div>` : ""}
          ${fp ? `<div class="card-fp">${fp}</div>` : ""}
          </a>
          <div class="card-tags">${tags.join("")}</div>
        </article>`;
    }
    $results.innerHTML = html;

    // Pagination
    const totalPages = Math.ceil(total / PAGE_SIZE);
    if (totalPages <= 1) {
      $pagination.innerHTML = "";
      return;
    }
    let pgHtml = `<button ${currentPage <= 1 ? "disabled" : ""} data-page="${currentPage - 1}">Prev</button>`;
    const start_p = Math.max(1, currentPage - 3);
    const end_p = Math.min(totalPages, currentPage + 3);
    if (start_p > 1)
      pgHtml += `<button data-page="1">1</button>${start_p > 2 ? "<span>...</span>" : ""}`;
    for (let p = start_p; p <= end_p; p++) {
      pgHtml += `<button data-page="${p}" ${p === currentPage ? 'class="active"' : ""}>${p}</button>`;
    }
    if (end_p < totalPages)
      pgHtml += `${end_p < totalPages - 1 ? "<span>...</span>" : ""}<button data-page="${totalPages}">${totalPages}</button>`;
    pgHtml += `<button ${currentPage >= totalPages ? "disabled" : ""} data-page="${currentPage + 1}">Next</button>`;
    $pagination.innerHTML = pgHtml;
    $pagination.querySelectorAll("button[data-page]").forEach((btn) => {
      btn.addEventListener("click", () => {
        currentPage = parseInt(btn.dataset.page);
        renderResults();
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
    });
  }

  // URL sync
  function updateURL() {
    const params = new URLSearchParams();
    if ($search.value) params.set("q", $search.value);
    if ($filterBrand.value) params.set("brand", $filterBrand.value);
    if ($filterAB.value) params.set("ab", $filterAB.value);
    if ($sort.value !== "brand") params.set("sort", $sort.value);

    const rels = [];
    document
      .querySelectorAll("#filter-release input:checked")
      .forEach((el) => rels.push(el.value));
    if (rels.length) params.set("release", rels.join(","));

    const fams = [];
    document
      .querySelectorAll("#filter-cpu input:checked")
      .forEach((el) => fams.push(el.value));
    if (fams.length) params.set("cpu", fams.join(","));

    const platforms = [];
    document
      .querySelectorAll("#filter-platform input:checked")
      .forEach((el) => platforms.push(el.value));
    if (platforms.length) params.set("platform", platforms.join(","));

    const gpus = [];
    document
      .querySelectorAll("#filter-gpu input:checked")
      .forEach((el) => gpus.push(el.value));
    if (gpus.length) params.set("gpu", gpus.join(","));

    const sizes = [];
    document
      .querySelectorAll("#filter-size input:checked")
      .forEach((el) => sizes.push(el.value));
    if (sizes.length) params.set("size", sizes.join(","));

    const qs = params.toString();
    history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
  }

  function applyURLParams() {
    const params = new URLSearchParams(location.search);
    if (params.has("q")) $search.value = params.get("q");
    if (params.has("brand")) $filterBrand.value = params.get("brand");
    if (params.has("ab")) $filterAB.value = params.get("ab");
    if (params.has("sort")) $sort.value = params.get("sort");

    if (params.has("release")) {
      const rels = new Set(params.get("release").split(","));
      document
        .querySelectorAll("#filter-release input")
        .forEach((el) => (el.checked = rels.has(el.value)));
    }
    if (params.has("cpu")) {
      const fams = new Set(params.get("cpu").split(","));
      document
        .querySelectorAll("#filter-cpu input")
        .forEach((el) => (el.checked = fams.has(el.value)));
    }
    if (params.has("platform")) {
      const platforms = new Set(params.get("platform").split(","));
      document
        .querySelectorAll("#filter-platform input")
        .forEach((el) => (el.checked = platforms.has(el.value)));
    }
    if (params.has("gpu")) {
      const gpus = new Set(params.get("gpu").split(","));
      document
        .querySelectorAll("#filter-gpu input")
        .forEach((el) => (el.checked = gpus.has(el.value)));
    }
    if (params.has("size")) {
      const sizes = new Set(params.get("size").split(","));
      document
        .querySelectorAll("#filter-size input")
        .forEach((el) => (el.checked = sizes.has(el.value)));
    }
  }

  // Helpers
  function esc(s) {
    if (!s) return "";
    const d = document.createElement("div");
    d.textContent = String(s);
    return d.innerHTML;
  }

  function debounce(fn, ms) {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  }

  async function fetchJson(url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    return response.json();
  }

  function renderLoadError(target) {
    if (location.protocol === "file:") {
      return `<div class="empty">Failed to load ${esc(target)}. This page must be served over HTTP, not opened directly from disk. From the <code>site</code> folder, run <code>python -m http.server 8000</code> and open <a href="http://127.0.0.1:8000">http://127.0.0.1:8000</a>.</div>`;
    }
    return `<div class="empty">Failed to load ${esc(target)}. Check the browser console and verify the <code>data/</code> files are being served.</div>`;
  }

  function clearPendingResults() {
    $results.innerHTML = "";
    $pagination.innerHTML = "";
    $resultCount.textContent = "Searching...";
  }

  function toggleFilters() {
    if (!$filtersPanel || !mobileFiltersMedia.matches) return;
    $filtersPanel.classList.toggle("is-open");
    syncFilterToggleState();
  }

  function syncFilterPanelForViewport() {
    if (!$filtersPanel) return;
    if (mobileFiltersMedia.matches) {
      if ($filtersPanel.dataset.viewportMode !== "mobile") {
        $filtersPanel.classList.remove("is-open");
      }
      $filtersPanel.dataset.viewportMode = "mobile";
    } else {
      $filtersPanel.classList.add("is-open");
      $filtersPanel.dataset.viewportMode = "desktop";
    }
    syncFilterToggleState();
  }

  function syncFilterGroupsForViewport() {
    if (!$filtersPanel) return;
    $filtersPanel.querySelectorAll("details.filter-group--section").forEach((group) => {
      if (!Object.prototype.hasOwnProperty.call(group.dataset, "desktopOpen")) {
        group.dataset.desktopOpen = group.hasAttribute("open") ? "true" : "false";
      }
      if (mobileFiltersMedia.matches) {
        const mobileDefault = group.dataset.mobileDefaultOpen;
        group.open = mobileDefault == null ? group.dataset.desktopOpen === "true" : mobileDefault === "true";
      } else {
        group.open = group.dataset.desktopOpen === "true";
      }
    });
  }

  function syncFilterToggleState() {
    if (!$filterToggle || !$filtersPanel) return;
    const expanded = !mobileFiltersMedia.matches || $filtersPanel.classList.contains("is-open");
    $filterToggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  }

  function updateFilterToggleCount({ brandFilter, abFilter, releaseCount, cpuCount, platformCount, gpuCount, sizeCount }) {
    if (!$filterToggleCount) return;
    let total = releaseCount + cpuCount + platformCount + gpuCount + sizeCount;
    if (brandFilter) total += 1;
    if (abFilter) total += 1;
    $filterToggleCount.textContent = `${total} active`;
  }

  function renderCheckboxFacet(values, options = {}) {
    const entries = Object.entries(values || {});
    const order = options.order || null;
    const formatter = options.formatter || formatFacetLabel;
    let sorted = entries;
    if (order) {
      const rank = new Map(order.map((value, index) => [value, index]));
      sorted = entries.sort((a, b) => {
        const ar = rank.has(a[0]) ? rank.get(a[0]) : 999;
        const br = rank.has(b[0]) ? rank.get(b[0]) : 999;
        if (ar !== br) return ar - br;
        return b[1] - a[1];
      });
    } else if (options.sort === "alpha") {
      sorted = entries.sort((a, b) => formatter(a[0]).localeCompare(formatter(b[0])));
    } else {
      sorted = entries.sort((a, b) => b[1] - a[1]);
    }
    if (options.limit) sorted = sorted.slice(0, options.limit);
    return sorted
      .map(([value, count]) => `<label><input type="checkbox" value="${esc(normalizeFacetValue(value))}"> ${esc(formatter(value))} <span class="filter-count">${count}</span></label>`)
      .join("");
  }

  function renderFilterTag(type, value, label, extraClass = "") {
    return `<button class="tag${extraClass ? ` ${esc(extraClass)}` : ""}" type="button" data-filter-type="${esc(type)}" data-filter-value="${esc(normalizeTagValue(type, value))}">${esc(label)}</button>`;
  }

  function handleResultClick(event) {
    const tag = event.target.closest(".tag[data-filter-type]");
    if (!tag || !$results.contains(tag)) return;
    event.preventDefault();
    event.stopPropagation();
    applyTagFilter(tag.dataset.filterType || "", tag.dataset.filterValue || "");
  }

  function applyTagFilter(type, value) {
    switch (type) {
      case "cpu":
        setCheckboxFilter("#filter-cpu", value);
        break;
      case "platform":
        setCheckboxFilter("#filter-platform", value);
        break;
      case "gpu":
        setCheckboxFilter("#filter-gpu", value);
        break;
      case "release":
        setCheckboxFilter("#filter-release", value);
        break;
      case "size":
        setCheckboxFilter("#filter-size", value);
        break;
      case "ab":
        if ($filterAB) $filterAB.value = value;
        break;
      default:
        return;
    }
    currentPage = 1;
    doSearch();
  }

  function setCheckboxFilter(rootSelector, value) {
    const input = document.querySelector(`${rootSelector} input[value="${cssEscape(value)}"]`);
    if (input) input.checked = true;
  }

  function normalizeTagValue(type, value) {
    if (type === "release") return normalizeRelease(value);
    if (type === "ab") return String(value || "");
    return normalizeFacetValue(value);
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(value);
    }
    return String(value).replace(/["\\]/g, "\\$&");
  }

  function normalizeFacetValue(value) {
    const text = String(value || "").trim().toLowerCase();
    return text || UNKNOWN_VALUE;
  }

  function normalizeRelease(value) {
    const text = String(value || "").trim();
    return /^\d+(?:\.\d+){0,2}$/.test(text) ? text : UNKNOWN_VALUE;
  }

  function formatFacetLabel(value) {
    return value === UNKNOWN_VALUE ? "Unknown" : value;
  }

  function formatTitleWords(value) {
    if (value === UNKNOWN_VALUE) return "Unknown";
    return String(value || "")
      .split(/[\s/_-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  // Go
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
